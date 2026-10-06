'use strict';
// ZeroDark Console — lightweight server monitoring & capacity planning.
// Zero npm dependencies: node:http + node:sqlite (Node >= 22.13).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { open, purge, tx, markSquadPortals } = require('./db');
const { analyze } = require('./analytics');
const { Users, ROLES, sessionCookie, sessionUser, publicUser } = require('./auth');
const { probe, fetchVersion } = require('./health');
const { Updates, serverVersions } = require('./updates');
const { Credentials, keyFrom } = require('./credentials');

const VERSION = require('../package.json').version;
// Written by the deploy workflow (commit, date, run); absent on manual installs.
const BUILD = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'build.json'), 'utf8'));
  } catch {
    return {};
  }
})();
const buildInfo = { version: VERSION, commit: BUILD.commit || null, built_at: BUILD.built_at || null, run: BUILD.run || null, repo: BUILD.repo || null };
const cfg = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  dbFile: process.env.DB_FILE || path.join(__dirname, '..', 'data', 'console.db'),
  retentionDays: Number(process.env.RETENTION_DAYS || 30),
  agentInterval: Number(process.env.AGENT_INTERVAL || 60),
  offlineAfter: Number(process.env.OFFLINE_AFTER || 300),
  headroom: Number(process.env.HEADROOM || 0.8),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  exportToken: process.env.EXPORT_TOKEN || '',
  cookieSecure: process.env.COOKIE_SECURE !== 'false',
  // Portals (gestionale) get <name>.<portalDomain> unless a domain is given.
  portalDomain: (process.env.PORTAL_DOMAIN || 'zerodarkteam.it').replace(/^\.+|\.+$/g, ''),
  healthInterval: Number(process.env.HEALTH_INTERVAL ?? 300),
  // Reverse proxy reachable on the internal Docker network: portal checks go through it directly.
  proxyHost: process.env.PROXY_HOST || '',
  // Gestionale updates: nightly automatic updates at UPDATE_HOUR (TIME_ZONE), versions asked every VERSIONS_INTERVAL s.
  updateHour: Number(process.env.UPDATE_HOUR ?? 4),
  timeZone: process.env.TIME_ZONE || 'Europe/Rome',
  versionsInterval: Number(process.env.VERSIONS_INTERVAL || 6 * 3600),
  releasesUrl: process.env.RELEASES_URL || 'https://github.com/whiskas85/team-management/releases/tag/v',
};

const db = open(cfg.dbFile);
const PUBLIC_DIR = path.join(__dirname, 'public');
const AGENT_DIR = path.join(__dirname, '..', 'agent');

// ---------------------------------------------------------------------------
// Settings / secrets
// ---------------------------------------------------------------------------
function setting(key, init) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row) return row.value;
  const v = init();
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?)').run(key, v);
  return v;
}
const SESSION_SECRET = setting('session_secret', () => crypto.randomBytes(32).toString('hex'));
const users = new Users(db);
const credentials = new Credentials(db, keyFrom(process.env.CREDENTIALS_KEY, SESSION_SECRET));
const updates = new Updates(db, { now: () => now(), tx, interval: cfg.versionsInterval, hour: cfg.updateHour, timeZone: cfg.timeZone });
if (!users.count()) {
  let pw = cfg.adminPassword;
  if (!pw) {
    pw = crypto.randomBytes(12).toString('base64url');
    console.log(`[console] ADMIN_PASSWORD non impostata: password iniziale dell'utente "admin" -> ${pw}`);
  }
  users.bootstrap(pw);
  console.log('[console] creato l\'utente "admin" (cambia la password da Account dopo il primo accesso)');
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => Math.floor(Date.now() / 1000);
const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const data = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Payload troppo grande'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'JSON non valido'));
      }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function baseUrl(req) {
  if (cfg.publicUrl) return cfg.publicUrl;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
const SESSION_TTL = 7 * 86400;
function currentUser(req) {
  if (req._user === undefined) req._user = sessionUser(SESSION_SECRET, users, cookies(req).zdt_session);
  return req._user;
}
// Any signed-in user can read; only the "admin" role can change things.
function requireUser(req) {
  const u = currentUser(req);
  if (!u) throw new HttpError(401, 'Non autenticato');
  return u;
}
function requireAdmin(req) {
  const u = requireUser(req);
  if (u.role !== 'admin') throw new HttpError(403, 'Operazione riservata agli amministratori');
  return u;
}
function setSession(req, res, user) {
  const secure = cfg.cookieSecure && (req.headers['x-forwarded-proto'] === 'https' || cfg.publicUrl.startsWith('https'));
  res.setHeader('Set-Cookie', `zdt_session=${sessionCookie(SESSION_SECRET, user, SESSION_TTL)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL}${secure ? '; Secure' : ''}`);
}
const authError = (e) => (e.status ? new HttpError(e.status, e.message) : e);
function requireAgent(req) {
  const token = bearer(req);
  if (!token) throw new HttpError(401, 'Token agent mancante');
  const server = db.prepare('SELECT * FROM servers WHERE token_hash = ?').get(sha256(token));
  if (!server) throw new HttpError(401, 'Token agent non valido');
  return server;
}

// Behind the reverse proxy every request comes from the proxy: use the client address it appended.
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : req.socket.remoteAddress;
}
const loginAttempts = new Map();
function throttleLogin(ip) {
  const t = now();
  if (loginAttempts.size > 10000) loginAttempts.clear();
  const rec = loginAttempts.get(ip) || { n: 0, t };
  if (t - rec.t > 900) {
    rec.n = 0;
    rec.t = t;
  }
  rec.n += 1;
  loginAttempts.set(ip, rec);
  if (rec.n > 10) throw new HttpError(429, 'Troppi tentativi, riprova tra qualche minuto');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;
// Portal names become a subdomain and container names (zd-sq-<name>-*): lowercase DNS label.
const PORTAL_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
// Same rule as the gestionale's squadra-server.sh: production, test instances and www are off limits.
const RESERVED_PORTAL_RE = /^(ops|www|test.*)$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,63}$/;
function str(v, max = 200) {
  if (v === undefined || v === null || v === '') return null;
  return String(v).slice(0, max);
}
function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function oneOf(v, list, def) {
  return list.includes(v) ? v : def;
}

const RANGES = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000 };
function rangeParams(q) {
  const span = Math.min(RANGES[q.get('range')] || 86400, cfg.retentionDays * 86400);
  const bucket = Math.max(cfg.agentInterval, Math.ceil(span / 300 / 60) * 60);
  const to = now();
  return { from: to - span, to, bucket };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
function latestServerMetrics(serverId) {
  return db.prepare('SELECT * FROM server_metrics WHERE server_id = ? ORDER BY ts DESC LIMIT 1').get(serverId) || null;
}

function serverSummary(s) {
  const m = latestServerMetrics(s.id);
  const apps = db.prepare(`SELECT COUNT(*) n FROM apps WHERE server_id = ? AND status NOT IN ${ARCHIVED}`).get(s.id).n;
  return {
    id: s.id,
    name: s.name,
    hostname: s.hostname,
    os: s.os,
    agent_version: s.agent_version,
    cpu_cores: s.cpu_cores,
    mem_total_mb: s.mem_total_mb,
    disk_total_gb: s.disk_total_gb,
    notes: s.notes,
    created_at: s.created_at,
    last_seen: s.last_seen,
    online: !!s.last_seen && now() - s.last_seen <= cfg.offlineAfter,
    apps,
    latest: m && { ...m, extra: m.extra ? JSON.parse(m.extra) : null },
  };
}

// Archived apps (and those being purged) live in the Archive, not with the running ones.
// 'unmonitored' = "Smetti di monitorare": kept in the Archive so an accidental click can be undone.
const ARCHIVED = "('archived', 'purging', 'unmonitored')";

function appRows(serverId) {
  return decorateApps(db.prepare(`SELECT * FROM apps WHERE server_id = ? AND status NOT IN ${ARCHIVED} ORDER BY name`).all(serverId));
}

function decorateApps(apps) {
  const since = now() - 86400;
  const servers = new Map();
  const serverOf = (id) => {
    if (!servers.has(id)) servers.set(id, db.prepare('SELECT * FROM servers WHERE id = ?').get(id));
    return servers.get(id);
  };
  return apps.map((a) => {
    const last = db.prepare('SELECT ts, cpu_pct, mem_mb, procs FROM app_metrics WHERE app_id = ? ORDER BY ts DESC LIMIT 1').get(a.id);
    const day = db.prepare('SELECT AVG(cpu_pct) cpu_avg, MAX(cpu_pct) cpu_max, AVG(mem_mb) mem_avg, MAX(mem_mb) mem_max FROM app_metrics WHERE app_id = ? AND ts >= ?').get(a.id, since);
    const cred = credentials.status(a.id);
    const credError = cred && cred.status === 'failed'
      ? db.prepare("SELECT message FROM tasks WHERE app_id = ? AND action = 'set_admin_password' ORDER BY id DESC LIMIT 1").get(a.id)?.message
      : undefined;
    return { ...a, latest: last || null, last24h: day, credentials: cred && { status: cred.status, username: cred.username, revealed_at: cred.revealed_at, revealed_by: cred.revealed_by, error: credError }, update: updates.decorate(a, serverOf(a.server_id)) };
  });
}

function seriesQuery(table, idCol, id, cols, { from, to, bucket }) {
  const sel = cols.map((c) => `AVG(${c}) AS ${c}`).join(', ');
  const max = cols.map((c) => `MAX(${c}) AS ${c}_max`).join(', ');
  return db
    .prepare(`SELECT (ts / ${bucket}) * ${bucket} AS t, ${sel}, ${max} FROM ${table} WHERE ${idCol} = ? AND ts BETWEEN ? AND ? GROUP BY t ORDER BY t`)
    .all(id, from, to);
}

function analysisInput(days) {
  const span = Math.min(days, cfg.retentionDays) * 86400;
  const bucket = Math.max(300, Math.ceil(span / 1500 / 60) * 60);
  const to = Math.floor(now() / bucket) * bucket;
  const from = to - (Math.floor(span / bucket) - 1) * bucket;
  const buckets = [];
  for (let t = from; t <= to; t += bucket) buckets.push(t);
  const index = new Map(buckets.map((t, i) => [t, i]));
  const T = buckets.length;
  const blank = () => new Array(T).fill(null);

  const servers = db.prepare('SELECT * FROM servers ORDER BY name').all();
  const apps = db.prepare(`SELECT * FROM apps WHERE status != 'removing' AND status NOT IN ${ARCHIVED} ORDER BY name`).all();
  const serverSeries = {};
  for (const r of db
    .prepare(
      `SELECT server_id, (ts / ${bucket}) * ${bucket} AS t, AVG(cpu_pct) cpu, AVG(mem_used_mb) mem, AVG(disk_used_gb) disk, AVG(swap_used_mb) swap
       FROM server_metrics WHERE ts >= ? GROUP BY server_id, t`
    )
    .all(from)) {
    const i = index.get(r.t);
    if (i === undefined) continue;
    const s = (serverSeries[r.server_id] ||= { cpu_pct: blank(), mem_used_mb: blank(), disk_used_gb: blank(), swap_used_mb: blank() });
    s.cpu_pct[i] = r.cpu;
    s.mem_used_mb[i] = r.mem;
    s.disk_used_gb[i] = r.disk;
    s.swap_used_mb[i] = r.swap;
  }
  const appSeries = {};
  for (const r of db
    .prepare(`SELECT app_id, (ts / ${bucket}) * ${bucket} AS t, AVG(cpu_pct) cpu, AVG(mem_mb) mem FROM app_metrics WHERE ts >= ? GROUP BY app_id, t`)
    .all(from)) {
    const i = index.get(r.t);
    if (i === undefined) continue;
    const s = (appSeries[r.app_id] ||= { cpu_pct: blank(), mem_mb: blank() });
    s.cpu_pct[i] = r.cpu;
    s.mem_mb[i] = r.mem;
  }
  return { buckets, servers, apps, serverSeries, appSeries };
}

// The analysis scans the whole window: cache it briefly, data only changes once per agent interval.
const analysisCache = new Map();
function runAnalysis(q) {
  const days = Math.max(1, Math.min(num(q.get('days')) || cfg.retentionDays, cfg.retentionDays));
  const headroom = Math.max(0.3, Math.min(num(q.get('headroom')) || cfg.headroom, 1));
  const n = Math.max(1, Math.min(num(q.get('n')) || 5, 20));
  const key = `${days}|${headroom}|${n}`;
  const hit = analysisCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.result;
  const result = analyze(analysisInput(days), { headroom, n, offlineAfter: cfg.offlineAfter });
  result.params.days = days;
  if (analysisCache.size > 50) analysisCache.clear();
  analysisCache.set(key, { at: Date.now(), result });
  return result;
}
const invalidateAnalysis = () => analysisCache.clear();

// ---------------------------------------------------------------------------
// Agent ingestion
// ---------------------------------------------------------------------------
function ingest(server, body) {
  const t = now();
  const samples = Array.isArray(body.samples) ? body.samples : [body];
  const minTs = t - cfg.retentionDays * 86400;
  let stored = 0;

  tx(db, () => {
    db.prepare(
      `UPDATE servers SET last_seen = ?, hostname = COALESCE(?, hostname), os = COALESCE(?, os), agent_version = COALESCE(?, agent_version),
       cpu_cores = COALESCE(?, cpu_cores), mem_total_mb = COALESCE(?, mem_total_mb), disk_total_gb = COALESCE(?, disk_total_gb) WHERE id = ?`
    ).run(t, str(body.hostname), str(body.os), str(body.agent_version, 40), num(body.cpu_cores), num(body.mem_total_mb), num(body.disk_total_gb), server.id);

    const insSrv = db.prepare(
      `INSERT INTO server_metrics (server_id, ts, cpu_pct, load1, load5, load15, mem_used_mb, mem_total_mb, swap_used_mb, disk_used_gb, disk_total_gb, net_rx_bps, net_tx_bps, procs, uptime_s, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insApp = db.prepare('INSERT INTO app_metrics (app_id, server_id, ts, cpu_pct, mem_mb, procs) VALUES (?, ?, ?, ?, ?, ?)');
    const findApp = db.prepare('SELECT id, status FROM apps WHERE server_id = ? AND name = ?');
    const newApp = db.prepare("INSERT INTO apps (server_id, name, type, kind, match, status, created_at) VALUES (?, ?, 'service', ?, ?, 'active', ?)");
    const touchApp = db.prepare('UPDATE apps SET last_seen = ? WHERE id = ?');

    for (const s of samples.slice(-5000)) {
      const ts = Math.round(num(s.ts) || t);
      if (ts < minTs || ts > t + 300) continue;
      const sys = s.system || {};
      const load = Array.isArray(sys.load) ? sys.load : [];
      insSrv.run(
        server.id, ts, num(sys.cpu_pct), num(load[0]), num(load[1]), num(load[2]), num(sys.mem_used_mb), num(sys.mem_total_mb ?? body.mem_total_mb),
        num(sys.swap_used_mb), num(sys.disk_used_gb), num(sys.disk_total_gb ?? body.disk_total_gb), num(sys.net_rx_bps), num(sys.net_tx_bps),
        num(sys.procs), num(sys.uptime_s), sys.extra ? JSON.stringify(sys.extra).slice(0, 4000) : null
      );
      stored++;
      for (const a of Array.isArray(s.apps) ? s.apps.slice(0, 200) : []) {
        const name = str(a.name, 63);
        if (!name || !NAME_RE.test(name)) continue;
        let row = findApp.get(server.id, name);
        if (!row) {
          newApp.run(server.id, name, oneOf(a.kind, ['process', 'docker', 'systemd'], 'process'), str(a.match), t);
          row = findApp.get(server.id, name);
        }
        if (['unmonitored', 'archived', 'purging'].includes(row.status)) continue; // not monitored on purpose
        insApp.run(row.id, server.id, ts, num(a.cpu_pct), num(a.mem_mb), num(a.procs));
        touchApp.run(ts, row.id);
      }
    }
  });
  return stored;
}

function agentConfig(server) {
  const apps = db
    .prepare("SELECT name, kind, match, type, domain, port FROM apps WHERE server_id = ? AND status IN ('active', 'provisioning')")
    .all(server.id);
  // Re-deliver tasks that were sent but never acknowledged (agent restart, network error...).
  let tasks = db
    .prepare("SELECT id, app_id, action, payload, status FROM tasks WHERE server_id = ? AND (status = 'queued' OR (status = 'sent' AND updated_at < ?)) ORDER BY id")
    .all(server.id, now() - 600);
  // One gestionale update at a time per server: each one restarts containers and runs a backup.
  let updating = !!db.prepare("SELECT 1 FROM tasks WHERE server_id = ? AND action = 'update_app' AND status = 'sent' AND updated_at >= ?").get(server.id, now() - 600);
  tasks = tasks.filter((t) => {
    if (t.action !== 'update_app') return true;
    if (updating) return false;
    updating = true;
    return true;
  });
  const mark = db.prepare("UPDATE tasks SET status = 'sent', updated_at = ? WHERE id = ?");
  const prov = db.prepare("UPDATE apps SET status = 'provisioning' WHERE id = (SELECT app_id FROM tasks WHERE id = ?) AND status = 'pending'");
  for (const t of tasks) {
    mark.run(now(), t.id);
    if (t.action === 'create_app') prov.run(t.id);
  }
  return {
    interval: cfg.agentInterval,
    apps,
    tasks: tasks.map((t) => {
      const payload = JSON.parse(t.payload);
      // Added at delivery time only: the stored payload never contains the password.
      if ((t.action === 'create_app' || t.action === 'set_admin_password') && t.app_id) {
        const pw = credentials.forProvisioning(t.app_id);
        if (pw) payload.admin_password = pw;
      }
      return { id: t.id, action: t.action, payload };
    }),
  };
}

function ackTask(server, id, body) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND server_id = ?').get(id, server.id);
  if (!task) throw new HttpError(404, 'Task non trovato');
  const ok = body.status === 'done';
  const msg = str(body.message, 2000);
  tx(db, () => {
    db.prepare('UPDATE tasks SET status = ?, message = ?, result = ?, updated_at = ? WHERE id = ?').run(ok ? 'done' : 'failed', msg, body.app && typeof body.app === 'object' ? JSON.stringify(body.app).slice(0, 4000) : null, now(), id);
    if (task.action === 'list_versions' || task.action === 'update_app') {
      updates.ack(task, ok, body.app && typeof body.app === 'object' ? body.app : null, msg);
      if (task.action === 'update_app' && task.app_id) setTimeout(() => checkAppHealth(task.app_id).catch(() => {}), 5000).unref();
      return;
    }
    if (!task.app_id) return;
    if (task.action === 'create_app') {
      db.prepare('UPDATE apps SET status = ?, status_msg = ? WHERE id = ?').run(ok ? 'active' : 'error', msg, task.app_id);
      const patch = body.app || {};
      if (ok && patch.match) db.prepare('UPDATE apps SET match = ?, kind = ? WHERE id = ?').run(str(patch.match), oneOf(patch.kind, ['process', 'docker', 'systemd'], 'process'), task.app_id);
      if (ok) setTimeout(() => checkAppHealth(task.app_id), 15000).unref();
      // create_app confirms with {"admin_password": "applied"} on its last line; otherwise the
      // gestionale picked its own password and the console must not show one.
      if (ok && credentials.status(task.app_id)) credentials.setStatus(task.app_id, patch.admin_password === 'applied' ? 'applied' : 'unsupported');
    } else if (task.action === 'set_admin_password') {
      // Same confirmation as create_app: without "applied" the old password may still be the valid one.
      if (credentials.status(task.app_id)) credentials.setStatus(task.app_id, ok && (body.app || {}).admin_password === 'applied' ? 'applied' : 'failed');
    } else if (task.action === 'remove_app') {
      // The portal is now in /opt/archivio (data volumes kept): it moves to the console's Archive.
      if (ok) {
        const archivePath = ((msg || '').match(/\/opt\/archivio\/[^\s"'`]+/) || [null])[0];
        db.prepare("UPDATE apps SET status = 'archived', status_msg = ?, archived_at = ?, archive_path = COALESCE(?, archive_path), health = NULL, health_code = NULL, health_error = NULL, health_at = NULL WHERE id = ?").run(msg, now(), archivePath, task.app_id);
      } else db.prepare("UPDATE apps SET status = 'error', status_msg = ? WHERE id = ?").run(msg, task.app_id);
    } else if (task.action === 'purge_app') {
      if (ok) db.prepare('DELETE FROM apps WHERE id = ?').run(task.app_id);
      else db.prepare("UPDATE apps SET status = 'archived', status_msg = ? WHERE id = ?").run(msg, task.app_id);
    }
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/healthz', () => ({ ok: true, ...buildInfo }));

route('POST', '/api/login', async (req, p, q, res) => {
  const ip = clientIp(req);
  throttleLogin(ip);
  const body = await readBody(req);
  const user = users.authenticate(str(body.username, 63) || 'admin', String(body.password || ''));
  if (!user) throw new HttpError(401, 'Nome utente o password errati');
  loginAttempts.delete(ip);
  setSession(req, res, user);
  return { ok: true, user: publicUser(user) };
});
route('POST', '/api/logout', (req, p, q, res) => {
  res.setHeader('Set-Cookie', 'zdt_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  return { ok: true };
});
route('GET', '/api/me', (req) => {
  const u = currentUser(req);
  return { authenticated: !!u, user: publicUser(u), version: VERSION, build: buildInfo, portal_domain: cfg.portalDomain, retention_days: cfg.retentionDays, headroom: cfg.headroom };
});
// Own account: change username and/or password. Always requires the current password.
route('PATCH', '/api/me', async (req, p, q, res) => {
  const me = requireUser(req);
  const body = await readBody(req);
  const fresh = users.authenticate(me.username, String(body.current_password || ''));
  if (!fresh) throw new HttpError(400, 'La password attuale non è corretta');
  const patch = {};
  if (body.username !== undefined && body.username !== me.username) patch.username = String(body.username).trim();
  if (body.new_password) patch.password = String(body.new_password);
  let updated;
  try {
    updated = users.update(me.id, patch);
  } catch (e) {
    throw authError(e);
  }
  setSession(req, res, updated); // keep this browser signed in, other sessions are logged out
  return { ok: true, user: publicUser(updated) };
});

// User management (admins)
route('GET', '/api/users', (req) => {
  requireAdmin(req);
  return { roles: ROLES, users: users.list() };
});
route('POST', '/api/users', async (req) => {
  requireAdmin(req);
  const body = await readBody(req);
  try {
    return publicUser(users.create(String(body.username || '').trim(), String(body.password || ''), oneOf(body.role, ROLES, 'viewer')));
  } catch (e) {
    throw authError(e);
  }
});
route('PATCH', '/api/users/:id', async (req, p, q, res) => {
  const me = requireAdmin(req);
  const body = await readBody(req);
  const patch = {};
  if (body.username !== undefined) patch.username = String(body.username).trim();
  if (body.role !== undefined) patch.role = String(body.role);
  if (body.password) patch.password = String(body.password);
  try {
    const u = users.update(Number(p.id), patch);
    if (u.id === me.id) setSession(req, res, u);
    return publicUser(u);
  } catch (e) {
    throw authError(e);
  }
});
route('DELETE', '/api/users/:id', (req, p) => {
  const me = requireAdmin(req);
  if (Number(p.id) === me.id) throw new HttpError(400, 'Non puoi eliminare il tuo stesso utente');
  try {
    users.remove(Number(p.id));
  } catch (e) {
    throw authError(e);
  }
  return { ok: true };
});

// Servers
route('GET', '/api/servers', (req) => {
  requireUser(req);
  return db.prepare('SELECT * FROM servers ORDER BY name').all().map(serverSummary);
});
route('POST', '/api/servers', async (req) => {
  requireAdmin(req);
  const body = await readBody(req);
  const name = str(body.name, 63);
  if (!name || !NAME_RE.test(name)) throw new HttpError(400, 'Nome server non valido (lettere, numeri, . _ -)');
  if (db.prepare('SELECT 1 FROM servers WHERE name = ?').get(name)) throw new HttpError(409, 'Esiste già un server con questo nome');
  const token = crypto.randomBytes(24).toString('hex');
  const r = db.prepare('INSERT INTO servers (name, token_hash, notes, created_at) VALUES (?, ?, ?, ?)').run(name, sha256(token), str(body.notes, 500), now());
  const base = baseUrl(req);
  invalidateAnalysis();
  return {
    id: Number(r.lastInsertRowid),
    name,
    token,
    install: `curl -fsSL ${base}/install.sh | sudo ZDT_URL=${base} ZDT_TOKEN=${token} bash`,
  };
});
route('GET', '/api/servers/:id', (req, p) => {
  requireUser(req);
  const s = db.prepare('SELECT * FROM servers WHERE id = ?').get(p.id);
  if (!s) throw new HttpError(404, 'Server non trovato');
  const tasks = db.prepare('SELECT t.*, a.name app_name FROM tasks t LEFT JOIN apps a ON a.id = t.app_id WHERE t.server_id = ? ORDER BY t.id DESC LIMIT 20').all(s.id);
  return { ...serverSummary(s), apps: appRows(s.id), tasks };
});
route('PATCH', '/api/servers/:id', async (req, p) => {
  requireAdmin(req);
  const body = await readBody(req);
  db.prepare('UPDATE servers SET notes = ? WHERE id = ?').run(str(body.notes, 500), p.id);
  return { ok: true };
});
route('DELETE', '/api/servers/:id', (req, p) => {
  requireAdmin(req);
  tx(db, () => {
    db.prepare('DELETE FROM app_metrics WHERE server_id = ?').run(p.id);
    db.prepare('DELETE FROM servers WHERE id = ?').run(p.id);
  });
  invalidateAnalysis();
  return { ok: true };
});
route('POST', '/api/servers/:id/token', (req, p) => {
  requireAdmin(req);
  const token = crypto.randomBytes(24).toString('hex');
  const r = db.prepare('UPDATE servers SET token_hash = ? WHERE id = ?').run(sha256(token), p.id);
  if (!r.changes) throw new HttpError(404, 'Server non trovato');
  const base = baseUrl(req);
  return { token, install: `curl -fsSL ${base}/install.sh | sudo ZDT_URL=${base} ZDT_TOKEN=${token} bash` };
});
route('GET', '/api/servers/:id/metrics', (req, p, q) => {
  requireUser(req);
  const r = rangeParams(q);
  return {
    ...r,
    rows: seriesQuery('server_metrics', 'server_id', p.id, ['cpu_pct', 'load1', 'mem_used_mb', 'mem_total_mb', 'swap_used_mb', 'disk_used_gb', 'disk_total_gb', 'net_rx_bps', 'net_tx_bps'], r),
  };
});

// Apps
route('POST', '/api/servers/:id/apps', async (req, p) => {
  requireAdmin(req);
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(p.id);
  if (!server) throw new HttpError(404, 'Server non trovato');
  const body = await readBody(req);
  const type = oneOf(body.type, ['portal', 'service', 'other'], 'portal');
  const name = str(body.name, 63);
  if (!name || !NAME_RE.test(name)) throw new HttpError(400, 'Nome app non valido (lettere, numeri, . _ -)');
  if (type === 'portal') {
    if (!PORTAL_NAME_RE.test(name)) throw new HttpError(400, 'Nome portale non valido: solo minuscole, numeri e trattini (max 40), diventa il sottodominio');
    if (RESERVED_PORTAL_RE.test(name)) throw new HttpError(400, `"${name}" è un nome riservato (ops, test*, www): scegline un altro, per una prova usa "demo"`);
  }
  let domain = str(body.domain, 253);
  if (domain) domain = domain.toLowerCase();
  if (domain && !DOMAIN_RE.test(domain)) throw new HttpError(400, 'Dominio non valido');
  if (type === 'portal' && !domain) domain = `${name}.${cfg.portalDomain}`;
  if (type === 'portal' && (domain === cfg.portalDomain || domain === `www.${cfg.portalDomain}`)) throw new HttpError(400, 'Dominio riservato');
  const email = str(body.email, 254);
  if (email && !EMAIL_RE.test(email)) throw new HttpError(400, 'Email non valida');
  const port = num(body.port);
  if (port !== null && (port < 1 || port > 65535 || !Number.isInteger(port))) throw new HttpError(400, 'Porta non valida');
  const existing = db.prepare('SELECT status FROM apps WHERE server_id = ? AND name = ?').get(server.id, name);
  if (existing) {
    if (existing.status === 'unmonitored') throw new HttpError(409, `"${name}" è nell'Archivio tra le app non monitorate: ricollegala da lì`);
    throw new HttpError(409, existing.status === 'archived' ? `"${name}" è nell'archivio: eliminalo definitivamente prima di riusare il nome` : 'App già presente su questo server');
  }
  // Portals: containers zd-sq-<name>-{db,app,whatsapp}, monitored as one app from the start.
  const kind = type === 'portal' ? 'docker' : oneOf(body.kind, ['process', 'docker', 'systemd'], 'docker');
  const match = type === 'portal' ? `^zd-sq-${name}-` : str(body.match, 200) || name;
  const template = str(body.template, 63);
  const provision = body.provision !== false;
  const t = now();
  const id = tx(db, () => {
    const r = db
      .prepare('INSERT INTO apps (server_id, name, type, kind, match, domain, port, template, status, provisioned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      // A portal registered without provisioning is still a gestionale squad (zd-sq-<name>-*, reserved names
      // refused above): the console may archive it later through remove_app.
      .run(server.id, name, type, kind, match, domain, port, template, provision ? 'pending' : 'active', provision || type === 'portal' ? 1 : 0, t);
    const appId = Number(r.lastInsertRowid);
    // Portals: the console picks the first-access password and hands it to create_app.
    if (provision && type === 'portal') credentials.create(appId, email, t);
    if (provision) {
      db.prepare("INSERT INTO tasks (server_id, app_id, action, payload, status, created_at, updated_at) VALUES (?, ?, 'create_app', ?, 'queued', ?, ?)").run(
        server.id, appId, JSON.stringify({ name, type, kind, match, domain, port, template, email }), t, t
      );
    }
    return appId;
  });
  invalidateAnalysis();
  return { id, status: provision ? 'pending' : 'active' };
});
route('DELETE', '/api/apps/:id', (req, p, q) => {
  const me = requireAdmin(req);
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(p.id);
  if (!app) throw new HttpError(404, 'App non trovata');
  if (q.get('deprovision') === '1') {
    // Only what the console created: never run remove_app on production or on apps found by the agent.
    if (!app.provisioned) throw new HttpError(400, `"${app.name}" non è stata creata dalla console: si può solo smettere di monitorarla`);
    if (q.get('confirm') !== app.name) throw new HttpError(400, `Per confermare scrivi il nome esatto: ${app.name}`);
    const t = now();
    tx(db, () => {
      db.prepare("UPDATE apps SET status = 'removing', archived_by = ? WHERE id = ?").run(me.username, app.id);
      db.prepare("INSERT INTO tasks (server_id, app_id, action, payload, status, created_at, updated_at) VALUES (?, ?, 'remove_app', ?, 'queued', ?, ?)").run(
        app.server_id, app.id, JSON.stringify({ name: app.name, type: app.type, kind: app.kind, match: app.match, domain: app.domain, port: app.port, template: app.template }), t, t
      );
    });
    return { status: 'removing' };
  }
  // Stop monitoring: nothing happens on the server, and the app waits in the Archive ("Ricollega").
  db.prepare("UPDATE apps SET status = 'unmonitored', archived_at = ?, archived_by = ? WHERE id = ?").run(now(), me.username, app.id);
  invalidateAnalysis();
  return { status: 'unmonitored' };
});
route('POST', '/api/apps/:id/reattach', (req, p) => {
  requireAdmin(req);
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(p.id);
  if (!app) throw new HttpError(404, 'App non trovata');
  if (app.status !== 'unmonitored') throw new HttpError(400, 'Si può ricollegare solo un\'app che non è più monitorata');
  db.prepare("UPDATE apps SET status = 'active', archived_at = NULL, archived_by = NULL WHERE id = ?").run(app.id);
  invalidateAnalysis();
  checkAppHealth(app.id).catch(() => {});
  return { status: 'active' };
});
// All apps across servers: running ones (view=all|portals) or the Archive (view=archive).
route('GET', '/api/apps', (req, p, q) => {
  requireUser(req);
  const view = q.get('view') || 'all';
  let where = `a.status NOT IN ${ARCHIVED}`;
  if (view === 'portals') where += " AND a.type = 'portal'";
  if (view === 'archive') where = `a.status IN ${ARCHIVED}`;
  const rows = db.prepare(`SELECT a.*, s.name AS server_name FROM apps a JOIN servers s ON s.id = a.server_id WHERE ${where} ORDER BY ${view === 'archive' ? 'a.archived_at DESC' : 'a.name'}`).all();
  return decorateApps(rows);
});
// Archive -> gone for good: purge_app deletes the data volumes and the archived folder on the server.
route('POST', '/api/apps/:id/purge', async (req, p) => {
  requireAdmin(req);
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(p.id);
  if (!app) throw new HttpError(404, 'App non trovata');
  if (!['archived', 'unmonitored'].includes(app.status)) throw new HttpError(400, "Si può eliminare definitivamente solo un'app nell'archivio");
  const body = await readBody(req);
  if (body.confirm !== app.name) throw new HttpError(400, `Per confermare scrivi il nome esatto: ${app.name}`);
  if (!app.provisioned || app.status === 'unmonitored') {
    // never created by the console: nothing to delete on the server, just forget it
    db.prepare('DELETE FROM apps WHERE id = ?').run(app.id);
    return { status: 'deleted' };
  }
  const t = now();
  tx(db, () => {
    db.prepare("UPDATE apps SET status = 'purging' WHERE id = ?").run(app.id);
    db.prepare("INSERT INTO tasks (server_id, app_id, action, payload, status, created_at, updated_at) VALUES (?, ?, 'purge_app', ?, 'queued', ?, ?)").run(
      app.server_id, app.id, JSON.stringify({ name: app.name, type: app.type, kind: app.kind, domain: app.domain, archive_path: app.archive_path }), t, t
    );
  });
  return { status: 'purging' };
});
// Edit how an app is shown and checked: type, domain, monitoring rule. Nothing changes on the server.
route('PATCH', '/api/apps/:id', async (req, p) => {
  requireAdmin(req);
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(p.id);
  if (!app) throw new HttpError(404, 'App non trovata');
  const body = await readBody(req);
  const type = body.type === undefined ? app.type : oneOf(body.type, ['portal', 'service', 'other'], app.type);
  let domain = body.domain === undefined ? app.domain : str(body.domain, 253);
  if (domain) domain = domain.toLowerCase();
  if (domain && !DOMAIN_RE.test(domain)) throw new HttpError(400, 'Dominio non valido');
  if (type === 'portal' && !domain) throw new HttpError(400, 'Un portale ha bisogno del suo dominio');
  const match = body.match === undefined ? app.match : str(body.match, 200) || app.name;
  if (app.kind !== 'systemd') {
    try {
      new RegExp(match);
    } catch {
      throw new HttpError(400, 'Criterio di monitoraggio non valido (espressione regolare)');
    }
  }
  const changedDomain = domain !== app.domain;
  db.prepare('UPDATE apps SET type = ?, domain = ?, match = ? WHERE id = ?').run(type, domain, match, app.id);
  markSquadPortals(db);
  if (changedDomain || type !== app.type) db.prepare('UPDATE apps SET health = NULL, health_code = NULL, health_error = NULL, health_at = NULL WHERE id = ?').run(app.id);
  invalidateAnalysis();
  checkAppHealth(app.id).catch(() => {});
  return db.prepare('SELECT id, name, type, domain, match FROM apps WHERE id = ?').get(app.id);
});
// First-access credentials of a portal created by the console (admins only, each view is recorded).
route('GET', '/api/apps/:id/credentials', (req, p) => {
  const me = requireAdmin(req);
  const app = db.prepare('SELECT id, domain FROM apps WHERE id = ?').get(p.id);
  if (!app) throw new HttpError(404, 'App non trovata');
  const c = credentials.reveal(app.id, me.username, now());
  if (!c) throw new HttpError(404, 'Nessuna credenziale iniziale per questa app');
  return { ...c, login_url: app.domain ? `https://${app.domain}/login` : null };
});
function agentAtLeast(version, min) {
  const a = String(version || '').split('.').map(Number);
  const b = min.split('.').map(Number);
  if (a.some(Number.isNaN) || a.length < 2) return false;
  for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i];
  return true;
}
// New first-access password for a portal created by the gestionale scripts (e.g. when create_app
// picked its own, or the owner lost it): the set_admin_password hook applies it and confirms.
route('POST', '/api/apps/:id/credentials/reset', (req, p) => {
  requireAdmin(req);
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(p.id);
  if (!app) throw new HttpError(404, 'App non trovata');
  if (app.type !== 'portal' || !app.provisioned) throw new HttpError(400, 'Solo per i portali delle squadre (creati dagli script del gestionale)');
  if (app.status !== 'active') throw new HttpError(400, 'Il portale deve essere attivo');
  // Agents before 0.1.3 do not pass ZDT_APP_ADMIN_PASSWORD to hooks: the hook would only see an empty password.
  const agent = db.prepare('SELECT agent_version FROM servers WHERE id = ?').get(app.server_id)?.agent_version;
  if (!agentAtLeast(agent, '0.1.3')) throw new HttpError(400, `L'agent sul server è troppo vecchio (${agent || 'versione sconosciuta'}) e non passa la password agli script: reinstallalo dal dettaglio server con «Installa agent», poi riprova.`);
  const busy = db.prepare("SELECT 1 FROM tasks WHERE app_id = ? AND action = 'set_admin_password' AND status IN ('queued', 'sent')").get(app.id);
  if (busy) throw new HttpError(409, 'Una nuova password è già in preparazione');
  const t = now();
  tx(db, () => {
    credentials.renew(app.id, t);
    db.prepare("INSERT INTO tasks (server_id, app_id, action, payload, status, created_at, updated_at) VALUES (?, ?, 'set_admin_password', ?, 'queued', ?, ?)").run(
      app.server_id, app.id, JSON.stringify({ name: app.name, type: app.type, kind: app.kind, match: app.match, domain: app.domain, email: credentials.status(app.id).username || undefined }), t, t
    );
  });
  return { status: 'resetting' };
});
// ---- Gestionale versions & updates -------------------------------------------------------
route('GET', '/api/apps/:id/updates', (req, p) => {
  requireUser(req);
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(p.id);
  if (!app) throw new HttpError(404, 'App non trovata');
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(app.server_id);
  const v = serverVersions(server);
  return {
    name: app.name, version: app.version, version_at: app.version_at, update: updates.decorate(app, server),
    available: v.available, latest: v.latest, versions_at: v.at, versions_error: v.error,
    history: updates.history(app.id), releases_url: cfg.releasesUrl, update_hour: cfg.updateHour, time_zone: cfg.timeZone,
  };
});
route('POST', '/api/apps/:id/update', async (req, p) => {
  const me = requireAdmin(req);
  const body = await readBody(req);
  try {
    return updates.request(Number(p.id), str(body.version, 20), { by: me.username });
  } catch (e) {
    throw new HttpError(400, e.message);
  }
});
route('POST', '/api/apps/:id/auto-update', async (req, p) => {
  requireAdmin(req);
  const body = await readBody(req);
  const app = db.prepare('SELECT * FROM apps WHERE id = ?').get(p.id);
  if (!app) throw new HttpError(404, 'App non trovata');
  if (!(app.type === 'portal' && app.provisioned)) throw new HttpError(400, 'Solo per i gestionali delle squadre');
  db.prepare('UPDATE apps SET auto_update = ? WHERE id = ?').run(body.enabled ? 1 : 0, app.id);
  return { auto_update: !!body.enabled };
});
// Ask every server which versions it has, now.
route('POST', '/api/updates/check', (req) => {
  requireAdmin(req);
  let n = 0;
  for (const { id } of db.prepare('SELECT id FROM servers').all()) if (updates.refresh(id, { force: true })) n++;
  return { servers: n };
});
// Every squad behind its server's latest version, one at a time per server.
route('POST', '/api/updates/all', (req) => {
  const me = requireAdmin(req);
  const queued = [];
  for (const { id } of db.prepare('SELECT id FROM servers').all()) {
    for (const { app, latest } of updates.behind(id)) {
      if (updates.pending(app.id)) continue;
      updates.request(app.id, latest, { by: me.username });
      queued.push(app.name);
    }
  }
  return { queued };
});
// "Verifica ora": any signed-in user may re-run the reachability check of a portal.
route('POST', '/api/apps/:id/health', async (req, p) => {
  requireUser(req);
  const r = await checkAppHealth(Number(p.id), { force: true });
  if (!r) throw new HttpError(400, 'Controllo disponibile solo per portali attivi con un dominio');
  return r;
});
route('GET', '/api/apps/:id/metrics', (req, p, q) => {
  requireUser(req);
  const r = rangeParams(q);
  return { ...r, rows: seriesQuery('app_metrics', 'app_id', p.id, ['cpu_pct', 'mem_mb'], r) };
});

// Analysis & export for the external AI tool
route('GET', '/api/analysis', (req, p, q) => {
  requireUser(req);
  return runAnalysis(q);
});
route('GET', '/api/v1/export', (req, p, q) => {
  const tok = bearer(req);
  if (!(currentUser(req) || (cfg.exportToken && tok && safeEq(sha256(tok), sha256(cfg.exportToken))))) throw new HttpError(401, 'Non autorizzato');
  const result = runAnalysis(q);
  return {
    schema: 'zerodark.console.capacity/v1',
    description:
      'Snapshot di capacità per il riassortimento delle app. cpu in core (1.0 = un core pieno), memoria in MB, percentili calcolati sulla finestra indicata. ' +
      '"combinations" sono le distribuzioni app->server migliori secondo il motore interno (score più basso = migliore). "base" = consumo del server non attribuito alle app monitorate.',
    retention_days: cfg.retentionDays,
    ...result,
  };
});

// Agent API
route('POST', '/api/agent/report', async (req) => {
  const server = requireAgent(req);
  const body = await readBody(req);
  const stored = ingest(server, body);
  return { ok: true, stored, ...agentConfig(server) };
});
route('POST', '/api/agent/tasks/:id', async (req, p) => {
  const server = requireAgent(req);
  return ackTask(server, Number(p.id), await readBody(req));
});

// Agent download
route('GET', '/install.sh', (req, p, q, res) => {
  const body = fs.readFileSync(path.join(AGENT_DIR, 'install.sh'), 'utf8').replaceAll('__ZDT_URL__', baseUrl(req));
  send(res, 200, body, { 'Content-Type': 'text/x-shellscript; charset=utf-8' });
});
route('GET', '/agent/zdt-agent.py', (req, p, q, res) => {
  send(res, 200, fs.readFileSync(path.join(AGENT_DIR, 'zdt-agent.py')), { 'Content-Type': 'text/x-python; charset=utf-8' });
});

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
// index.html links its scripts and styles with ?v=<version>-<commit>: a new release is picked up
// by the browser immediately instead of after the cache expires.
const ASSET_VERSION = encodeURIComponent(`${VERSION}-${(BUILD.commit || 'dev').slice(0, 7)}`);
let indexHtml = null;
function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  if (file.endsWith('index.html')) {
    indexHtml ||= fs.readFileSync(file, 'utf8').replace(/(src|href)="\/([\w.-]+\.(?:js|css))"/g, `$1="/$2?v=${ASSET_VERSION}"`);
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
    return res.end(indexHtml);
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  });
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const out = await r.handler(req, params, url.searchParams, res);
      if (!res.headersSent && out !== undefined) send(res, 200, out);
      return;
    }
    if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'Endpoint non trovato');
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Metodo non consentito');
    serveStatic(req, res, url.pathname);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Errore interno' : e.message });
  }
});

// ---------------------------------------------------------------------------
// Portal health: https://<domain>/login must answer 200
// ---------------------------------------------------------------------------
let healthEnabled = false;
async function checkAppHealth(appId, { force = false } = {}) {
  if (!healthEnabled && !force) return null;
  const app = db.prepare("SELECT id, domain FROM apps WHERE id = ? AND type = 'portal' AND status = 'active' AND domain IS NOT NULL").get(appId);
  if (!app) return null;
  const opts = { connectHost: cfg.proxyHost || undefined, referenceHost: cfg.publicUrl ? new URL(cfg.publicUrl).hostname : undefined };
  const { code, error } = await probe(app.domain, opts);
  db.prepare('UPDATE apps SET health = ?, health_code = ?, health_error = ?, health_at = ? WHERE id = ?').run(error ? 'down' : 'ok', code, error, now(), app.id);
  // The running version, when the gestionale tells it (GET /api/stato, from 3.25)
  if (!error) {
    const version = await fetchVersion(app.domain, opts).catch(() => null);
    if (version) updates.setVersion(app.id, version);
  }
  return db.prepare('SELECT health, health_code, health_error, health_at FROM apps WHERE id = ?').get(app.id);
}
// Healthy portals every HEALTH_INTERVAL; portals that are down (typically waiting for DNS or
// for the certificate) every minute, so the badge turns green soon after the site comes up.
async function checkAllHealth() {
  const t = now();
  const due = db
    .prepare("SELECT id FROM apps WHERE type = 'portal' AND status = 'active' AND domain IS NOT NULL AND (health_at IS NULL OR health_at <= ? OR (health IS NOT 'ok' AND health_at <= ?))")
    .all(t - cfg.healthInterval + 5, t - 55);
  for (const { id } of due) await checkAppHealth(id);
}

function housekeeping() {
  try {
    const r = purge(db, cfg.retentionDays);
    if (r.server_metrics || r.app_metrics) console.log(`[console] retention ${cfg.retentionDays}g: rimossi`, r);
  } catch (e) {
    console.error('[console] purge failed', e);
  }
}

if (require.main === module) {
  housekeeping();
  setInterval(housekeeping, 3600 * 1000).unref();
  if (cfg.healthInterval > 0) {
    healthEnabled = true;
    setTimeout(checkAllHealth, 5000).unref();
    setInterval(checkAllHealth, 60 * 1000).unref();
  }
  const versionsTick = () => {
    try {
      updates.refreshAll();
      const auto = updates.autoUpdate();
      if (auto.length) console.log('[console] aggiornamenti automatici in coda:', auto.join(', '));
    } catch (e) {
      console.error('[console] versions', e);
    }
  };
  setTimeout(versionsTick, 10000).unref();
  setInterval(versionsTick, 5 * 60 * 1000).unref();
  server.listen(cfg.port, cfg.host, () => console.log(`[console] v${VERSION}${BUILD.commit ? ` (${BUILD.commit.slice(0, 7)})` : ''} in ascolto su http://${cfg.host}:${cfg.port} (retention ${cfg.retentionDays} giorni)`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { server, db, cfg };
