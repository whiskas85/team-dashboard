#!/usr/bin/env python3
"""ZeroDark Console agent.

Collects host metrics (CPU, RAM, swap, disk, network, load, ...) and per-app
CPU/RAM usage, sends them to the console every `interval` seconds and runs the
provisioning tasks (create/remove app) queued from the dashboard.

Python 3.6+ standard library only. Linux only (reads /proc and cgroup v2).

Config: /etc/zdt-agent/config.json (override with ZDT_CONFIG)
  {
    "url": "https://console.zerodarkteam.it",
    "token": "...",
    "disk_paths": ["/"],
    "hooks_dir": "/etc/zdt-agent/hooks",
    "apps": [ {"name": "ops", "kind": "docker", "match": "^ops"} ]
  }
App kinds:
  process  -> `match` is a regex tested against each process command line
  docker   -> `match` is a regex tested against container names
  systemd  -> `match` is the unit name (e.g. "ops.service")
"""

import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

VERSION = "0.1.4"
CONFIG_PATH = os.environ.get("ZDT_CONFIG", "/etc/zdt-agent/config.json")
STATE_DIR = os.environ.get("ZDT_STATE_DIR", "/var/lib/zdt-agent")
CLK_TCK = os.sysconf("SC_CLK_TCK")
PAGE = os.sysconf("SC_PAGE_SIZE")
CGROOT = "/sys/fs/cgroup"
MAX_BACKLOG = 1440  # ~24h at 60s
NET_SKIP = re.compile(r"^(lo|veth|docker|br-|virbr|cni|flannel|cali|tun|wg)")


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


def read(path, default=""):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return default


# ---------------------------------------------------------------------------
# Host metrics
# ---------------------------------------------------------------------------
def cpu_times():
    parts = read("/proc/stat").splitlines()[0].split()[1:]
    vals = [int(x) for x in parts]
    vals += [0] * (8 - len(vals))
    user, nice, system, idle, iowait, irq, softirq, steal = vals[:8]
    total = user + nice + system + idle + iowait + irq + softirq + steal
    return {"total": total, "idle": idle + iowait, "iowait": iowait, "steal": steal}


def meminfo():
    out = {}
    for line in read("/proc/meminfo").splitlines():
        k, _, v = line.partition(":")
        out[k] = int(v.split()[0]) / 1024.0  # kB -> MB
    return out


def net_bytes():
    rx = tx = 0
    for line in read("/proc/net/dev").splitlines()[2:]:
        name, _, rest = line.partition(":")
        name = name.strip()
        if NET_SKIP.match(name):
            continue
        f = rest.split()
        rx += int(f[0])
        tx += int(f[8])
    return rx, tx


def tcp_established():
    n = 0
    for p in ("/proc/net/tcp", "/proc/net/tcp6"):
        for line in read(p).splitlines()[1:]:
            f = line.split()
            if len(f) > 3 and f[3] == "01":
                n += 1
    return n


def disk(path):
    st = os.statvfs(path)
    total = st.f_blocks * st.f_frsize
    free = st.f_bavail * st.f_frsize
    used = total - st.f_bfree * st.f_frsize
    return {"path": path, "total_gb": round(total / 1e9, 2), "used_gb": round(used / 1e9, 2), "free_gb": round(free / 1e9, 2)}


# ---------------------------------------------------------------------------
# Per-app metrics
# ---------------------------------------------------------------------------
def list_pids():
    return [int(d) for d in os.listdir("/proc") if d.isdigit()]


def proc_info(pid):
    try:
        stat = read("/proc/%d/stat" % pid)
        rest = stat[stat.rindex(")") + 2:].split()
        ticks = int(rest[11]) + int(rest[12])  # utime + stime
        rss = int(read("/proc/%d/statm" % pid).split()[1]) * PAGE
        cmd = read("/proc/%d/cmdline" % pid).replace("\0", " ").strip()
        if not cmd:
            cmd = stat[stat.index("(") + 1:stat.rindex(")")]
        return ticks, rss, cmd
    except (OSError, ValueError, IndexError):
        return None


def cgroup_usage(cg):
    """(cpu_usec, mem_bytes) for a cgroup v2 directory, or None."""
    stat = read(os.path.join(cg, "cpu.stat"))
    m = re.search(r"^usage_usec (\d+)", stat, re.M)
    cur = read(os.path.join(cg, "memory.current")).strip()
    if not m or not cur:
        return None
    mem = int(cur)
    inactive = re.search(r"^inactive_file (\d+)", read(os.path.join(cg, "memory.stat")), re.M)
    if inactive:
        mem = max(0, mem - int(inactive.group(1)))
    procs = len(read(os.path.join(cg, "cgroup.procs")).split())
    return int(m.group(1)), mem, procs


def docker_containers():
    try:
        out = subprocess.run(
            ["docker", "ps", "--no-trunc", "--format", "{{.ID}}\t{{.Names}}"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20, universal_newlines=True,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return [tuple(l.split("\t", 1)) for l in out.splitlines() if "\t" in l]


def docker_cgroup(cid):
    for p in ("system.slice/docker-%s.scope" % cid, "docker/%s" % cid):
        full = os.path.join(CGROOT, p)
        if os.path.isdir(full):
            return full
    return None


def docker_stats_fallback(names):
    """When cgroup v2 is not available: one `docker stats` call. Returns {name: (cpu_pct, mem_mb)}."""
    if not names:
        return {}
    try:
        out = subprocess.run(
            ["docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"] + names,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=60, universal_newlines=True,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    units = {"B": 1 / 1048576.0, "KiB": 1 / 1024.0, "kB": 1 / 1048.576, "MiB": 1.0, "MB": 0.953674, "GiB": 1024.0, "GB": 953.674}
    res = {}
    for line in out.splitlines():
        try:
            n, cpu, mem = line.split("\t")
            m = re.match(r"([\d.]+)\s*([A-Za-z]+)", mem.split("/")[0].strip())
            res[n] = (float(cpu.strip("%")), float(m.group(1)) * units.get(m.group(2), 1.0))
        except (ValueError, AttributeError):
            continue
    return res


class AppCollector:
    def __init__(self):
        self.prev_ticks = {}   # pid -> ticks
        self.prev_cg = {}      # cgroup path -> usec
        self.prev_t = None

    def collect(self, apps):
        t = time.time()
        dt = (t - self.prev_t) if self.prev_t else None
        self.prev_t = t
        results = []

        # processes: scan /proc once
        proc_apps = [a for a in apps if a.get("kind", "process") == "process" and a.get("match")]
        if proc_apps:
            pats = []
            for a in proc_apps:
                try:
                    pats.append((a, re.compile(a["match"])))
                except re.error:
                    log("regex non valida per app", a.get("name"))
            agg = {a["name"]: [0.0, 0.0, 0] for a, _ in pats}
            ticks_now = {}
            for pid in list_pids():
                if pid == os.getpid():
                    continue
                info = proc_info(pid)
                if not info:
                    continue
                ticks, rss, cmd = info
                ticks_now[pid] = ticks
                for a, rx in pats:
                    if rx.search(cmd):
                        acc = agg[a["name"]]
                        if dt and pid in self.prev_ticks:
                            acc[0] += max(0, ticks - self.prev_ticks[pid]) / CLK_TCK / dt * 100
                        acc[1] += rss / 1048576.0
                        acc[2] += 1
                        break
            self.prev_ticks = ticks_now
            for a, _ in pats:
                cpu, mem, n = agg[a["name"]]
                results.append({"name": a["name"], "kind": "process", "match": a["match"],
                                "cpu_pct": round(cpu, 2) if dt else None, "mem_mb": round(mem, 1), "procs": n})

        # cgroup based (systemd units and docker containers)
        cg_seen = {}
        containers = None
        fallback = []
        for a in apps:
            kind = a.get("kind")
            if kind not in ("docker", "systemd"):
                continue
            groups = []
            if kind == "systemd":
                unit = a.get("match") or a["name"]
                if "." not in unit:
                    unit += ".service"
                p = os.path.join(CGROOT, "system.slice", unit)
                if os.path.isdir(p):
                    groups.append(p)
            else:
                if containers is None:
                    containers = docker_containers()
                try:
                    rx = re.compile(a.get("match") or "^%s" % re.escape(a["name"]))
                except re.error:
                    continue
                names = []
                for cid, name in containers:
                    if rx.search(name):
                        cg = docker_cgroup(cid)
                        if cg:
                            groups.append(cg)
                        else:
                            names.append(name)
                if names:
                    fallback.append((a, names))
                    continue
            cpu = 0.0
            mem = 0.0
            procs = 0
            has_cpu = dt is not None
            for g in groups:
                u = cgroup_usage(g)
                if not u:
                    continue
                usec, membytes, n = u
                cg_seen[g] = usec
                if dt and g in self.prev_cg:
                    cpu += max(0, usec - self.prev_cg[g]) / 1e6 / dt * 100
                else:
                    has_cpu = False
                mem += membytes / 1048576.0
                procs += n
            results.append({"name": a["name"], "kind": kind, "match": a.get("match"),
                            "cpu_pct": round(cpu, 2) if has_cpu else None, "mem_mb": round(mem, 1), "procs": procs})
        self.prev_cg = cg_seen

        if fallback:
            stats = docker_stats_fallback(sorted({n for _, ns in fallback for n in ns}))
            for a, names in fallback:
                cpu = sum(stats.get(n, (0, 0))[0] for n in names)
                mem = sum(stats.get(n, (0, 0))[1] for n in names)
                results.append({"name": a["name"], "kind": "docker", "match": a.get("match"),
                                "cpu_pct": round(cpu, 2), "mem_mb": round(mem, 1), "procs": len(names)})
        return results


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------
class Agent:
    def __init__(self, cfg):
        self.cfg = cfg
        self.url = cfg["url"].rstrip("/")
        self.token = cfg["token"]
        self.interval = int(cfg.get("interval", 60))
        self.disk_paths = cfg.get("disk_paths") or ["/"]
        self.hooks_dir = cfg.get("hooks_dir", "/etc/zdt-agent/hooks")
        self.local_apps = cfg.get("apps") or []
        self.remote_apps = []
        self.apps_coll = AppCollector()
        self.prev_cpu = cpu_times()
        self.prev_net = (time.time(), net_bytes())
        self.backlog = []
        self.handled = set(self._load_handled())
        self.lock = threading.Lock()

    # -- state -------------------------------------------------------------
    def _state_file(self):
        return os.path.join(STATE_DIR, "tasks.json")

    def _load_handled(self):
        try:
            return json.loads(read(self._state_file(), "[]"))
        except ValueError:
            return []

    def _save_handled(self):
        try:
            os.makedirs(STATE_DIR, exist_ok=True)
            with open(self._state_file(), "w") as f:
                json.dump(sorted(self.handled)[-500:], f)
        except OSError as e:
            log("impossibile salvare lo stato:", e)

    # -- collection --------------------------------------------------------
    def apps(self):
        merged = {}
        for a in self.remote_apps + self.local_apps:  # local config wins
            if a.get("name"):
                merged[a["name"]] = a
        return list(merged.values())

    def sample(self):
        cur = cpu_times()
        d_total = max(1, cur["total"] - self.prev_cpu["total"])
        cpu_pct = 100.0 * (1 - (cur["idle"] - self.prev_cpu["idle"]) / d_total)
        iowait = 100.0 * (cur["iowait"] - self.prev_cpu["iowait"]) / d_total
        steal = 100.0 * (cur["steal"] - self.prev_cpu["steal"]) / d_total
        self.prev_cpu = cur

        t = time.time()
        rx, tx = net_bytes()
        pt, (prx, ptx) = self.prev_net
        el = max(1e-3, t - pt)
        self.prev_net = (t, (rx, tx))

        mi = meminfo()
        disks = []
        for p in self.disk_paths:
            try:
                disks.append(disk(p))
            except OSError:
                pass
        main = disks[0] if disks else {"total_gb": None, "used_gb": None}
        load = os.getloadavg()

        return {
            "ts": int(t),
            "system": {
                "cpu_pct": round(max(0.0, min(100.0, cpu_pct)), 2),
                "load": [round(x, 2) for x in load],
                "mem_total_mb": round(mi.get("MemTotal", 0)),
                "mem_used_mb": round(mi.get("MemTotal", 0) - mi.get("MemAvailable", mi.get("MemFree", 0)), 1),
                "swap_used_mb": round(mi.get("SwapTotal", 0) - mi.get("SwapFree", 0), 1),
                "disk_total_gb": main["total_gb"],
                "disk_used_gb": main["used_gb"],
                "net_rx_bps": round(max(0, rx - prx) / el),
                "net_tx_bps": round(max(0, tx - ptx) / el),
                "procs": len(list_pids()),
                "uptime_s": int(float(read("/proc/uptime", "0 0").split()[0])),
                "extra": {
                    "iowait_pct": round(iowait, 2),
                    "steal_pct": round(steal, 2),
                    "mem_cached_mb": round(mi.get("Cached", 0) + mi.get("Buffers", 0), 1),
                    "tcp_established": tcp_established(),
                    "disks": disks,
                },
            },
            "apps": self.apps_coll.collect(self.apps()),
        }

    def host_info(self):
        os_name = ""
        for line in read("/etc/os-release").splitlines():
            if line.startswith("PRETTY_NAME="):
                os_name = line.split("=", 1)[1].strip('"')
        mi = meminfo()
        d = disk(self.disk_paths[0]) if self.disk_paths else {"total_gb": None}
        return {
            "hostname": socket.gethostname(),
            "os": os_name or sys.platform,
            "agent_version": VERSION,
            "cpu_cores": os.cpu_count(),
            "mem_total_mb": round(mi.get("MemTotal", 0)),
            "disk_total_gb": d["total_gb"],
        }

    # -- transport ---------------------------------------------------------
    def post(self, path, payload, timeout=30):
        req = urllib.request.Request(
            self.url + path,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + self.token, "User-Agent": "zdt-agent/" + VERSION},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode() or "{}")

    def report(self, s):
        batch = self.backlog + [s]
        body = dict(self.host_info())
        body["samples"] = batch
        try:
            resp = self.post("/api/agent/report", body)
        except urllib.error.HTTPError as e:
            log("report rifiutato:", e.code, e.read()[:200])
            if e.code in (401, 403):
                self.backlog = []  # bad token: buffering is pointless
                return
            self.backlog = batch[-MAX_BACKLOG:]
            return
        except (urllib.error.URLError, OSError, ValueError) as e:
            log("console non raggiungibile:", e)
            self.backlog = batch[-MAX_BACKLOG:]
            return
        self.backlog = []
        self.interval = int(resp.get("interval") or self.interval)
        self.remote_apps = resp.get("apps") or []
        for task in resp.get("tasks") or []:
            self.dispatch(task)

    # -- tasks -------------------------------------------------------------
    def dispatch(self, task):
        with self.lock:
            if task["id"] in self.handled:
                return
            self.handled.add(task["id"])
        threading.Thread(target=self.run_task, args=(task,), daemon=True).start()

    def run_task(self, task):
        action = task["action"]
        p = task.get("payload") or {}
        hook = os.path.join(self.hooks_dir, action)
        log("task", task["id"], action, p.get("name"))
        result = {"status": "failed", "message": ""}
        if not (os.path.isfile(hook) and os.access(hook, os.X_OK)):
            result["message"] = "Hook %s non installato o non eseguibile: vedi agent/hooks/ nel repository." % hook
        else:
            env = dict(os.environ)
            for k in ("name", "type", "kind", "match", "domain", "port", "template", "email", "admin_password", "archive_path", "version"):
                env["ZDT_APP_" + k.upper()] = "" if p.get(k) is None else str(p.get(k))
            try:
                r = subprocess.run([hook], input=json.dumps(p), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   env=env, timeout=1800, universal_newlines=True)
                out = r.stdout.strip()
                result["status"] = "done" if r.returncode == 0 else "failed"
                result["message"] = out[-2000:] or ("exit %d" % r.returncode)
                # A hook may print a final JSON line like {"match": "^ops-acme", "kind": "docker"}
                last = out.splitlines()[-1] if out else ""
                if last.startswith("{"):
                    try:
                        result["app"] = json.loads(last)
                    except ValueError:
                        pass
            except subprocess.TimeoutExpired:
                result["message"] = "Timeout esecuzione hook"
            except OSError as e:
                result["message"] = str(e)
        for attempt in range(5):
            try:
                self.post("/api/agent/tasks/%d" % task["id"], result)
                break
            except (urllib.error.URLError, OSError, ValueError) as e:
                log("ack task fallito:", e)
                time.sleep(5 * (attempt + 1))
        with self.lock:
            self._save_handled()
        log("task", task["id"], result["status"])

    # -- loop --------------------------------------------------------------
    def run(self):
        log("zdt-agent", VERSION, "->", self.url)
        self.apps_coll.collect(self.apps())  # prime CPU deltas
        time.sleep(min(5, self.interval))
        while True:
            start = time.time()
            try:
                self.report(self.sample())
            except Exception as e:  # never die on a bad sample
                log("errore raccolta:", repr(e))
            time.sleep(max(1, self.interval - (time.time() - start)))


def load_config():
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH) as f:
            cfg = json.load(f)
    cfg["url"] = os.environ.get("ZDT_URL", cfg.get("url", ""))
    cfg["token"] = os.environ.get("ZDT_TOKEN", cfg.get("token", ""))
    return cfg


def main():
    cfg = load_config()
    if "--print" in sys.argv:
        cfg.setdefault("url", "")
        cfg.setdefault("token", "")
        a = Agent(cfg)
        a.apps_coll.collect(a.apps())
        time.sleep(2)
        out = dict(a.host_info())
        out["samples"] = [a.sample()]
        print(json.dumps(out, indent=2))
        return
    if not cfg["url"] or not cfg["token"]:
        sys.exit("Configura url e token in %s (o ZDT_URL / ZDT_TOKEN)" % CONFIG_PATH)
    Agent(cfg).run()


if __name__ == "__main__":
    main()
