'use strict';
// Capacity analysis + placement ("combinazioni ideali") engine.
// Pure functions over pre-bucketed, time-aligned series so it is easy to test.

const STATUS_RANK = { ok: 0, info: 1, warning: 2, critical: 3, offline: 3 };
// Days of data needed before a trend ("full in N days") is reported: fewer gives false alarms.
const MIN_TREND_DAYS = 5;

function clean(arr) {
  return arr.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
}

function percentile(arr, p) {
  const a = clean(arr).sort((x, y) => x - y);
  if (!a.length) return null;
  const idx = (a.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

function mean(arr) {
  const a = clean(arr);
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
}

function max(arr) {
  const a = clean(arr);
  return a.length ? Math.max(...a) : null;
}

// Least squares slope over (x, y) pairs, skipping gaps. Returns null with < 2 points.
function linreg(xs, ys) {
  const pts = [];
  for (let i = 0; i < xs.length; i++) {
    if (ys[i] !== null && ys[i] !== undefined && Number.isFinite(ys[i])) pts.push([xs[i], ys[i]]);
  }
  if (pts.length < 2) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of pts) {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  if (den === 0) return null;
  const slope = num / den;
  return { slope, intercept: my - slope * mx, n };
}

// Groups an aligned series into per-day values using `fn` (e.g. p95) -> { days: [dayIndex], vals: [] }
function daily(buckets, values, fn) {
  const byDay = new Map();
  buckets.forEach((ts, i) => {
    const d = Math.floor(ts / 86400);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(values[i]);
  });
  const days = [];
  const vals = [];
  for (const [d, v] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    const r = fn(v);
    if (r !== null) {
      days.push(d);
      vals.push(r);
    }
  }
  return { days, vals };
}

// Days until `current + slope*days` reaches `limit` (null if not growing / no data).
function daysUntil(current, slopePerDay, limit) {
  if (current === null || slopePerDay === null || !(slopePerDay > 1e-9)) return null;
  if (current >= limit) return 0;
  return (limit - current) / slopePerDay;
}

function hourlyProfile(buckets, values) {
  const sums = new Array(24).fill(0);
  const counts = new Array(24).fill(0);
  buckets.forEach((ts, i) => {
    const v = values[i];
    if (v === null || v === undefined || !Number.isFinite(v)) return;
    const h = new Date(ts * 1000).getHours();
    sums[h] += v;
    counts[h] += 1;
  });
  return sums.map((s, h) => (counts[h] ? round(s / counts[h], 3) : null));
}

function round(v, d = 1) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function fillGaps(arr, fallback) {
  return arr.map((v) => (v === null || v === undefined || !Number.isFinite(v) ? fallback : v));
}

// ---------------------------------------------------------------------------
// Per-entity reports
// ---------------------------------------------------------------------------

function analyzeApp(app, s, buckets) {
  const cores = s.cpu_pct.map((v) => (v === null ? null : v / 100));
  const samples = clean(s.mem_mb).length;
  const memDaily = daily(buckets, s.mem_mb, (v) => percentile(v, 0.95));
  const cpuDaily = daily(buckets, cores, (v) => percentile(v, 0.95));
  const memTrend = linreg(memDaily.days, memDaily.vals);
  const cpuTrend = linreg(cpuDaily.days, cpuDaily.vals);
  return {
    id: app.id,
    name: app.name,
    server_id: app.server_id,
    type: app.type,
    status: app.status,
    samples,
    cpu: {
      avg_cores: round(mean(cores), 3),
      p95_cores: round(percentile(cores, 0.95), 3),
      max_cores: round(max(cores), 3),
    },
    mem: {
      avg_mb: round(mean(s.mem_mb)),
      p95_mb: round(percentile(s.mem_mb, 0.95)),
      max_mb: round(max(s.mem_mb)),
    },
    trend: {
      mem_mb_per_day: memTrend && memDaily.vals.length >= MIN_TREND_DAYS ? round(memTrend.slope, 2) : null,
      cpu_cores_per_day: cpuTrend && cpuDaily.vals.length >= MIN_TREND_DAYS ? round(cpuTrend.slope, 4) : null,
    },
    profile_hourly: {
      cpu_cores: hourlyProfile(buckets, cores),
      mem_mb: hourlyProfile(buckets, s.mem_mb),
    },
  };
}

function analyzeServer(server, s, appReports, buckets, appSeries, opts) {
  const cores = server.cpu_cores || null;
  const memTotal = server.mem_total_mb || null;
  const diskTotal = server.disk_total_gb || null;
  const usedCores = s.cpu_pct.map((v) => (v === null || !cores ? null : (v / 100) * cores));

  const cpuP95 = percentile(s.cpu_pct, 0.95);
  const memP95 = percentile(s.mem_used_mb, 0.95);
  const memP95Pct = memTotal && memP95 !== null ? (memP95 / memTotal) * 100 : null;
  const diskNow = lastValue(s.disk_used_gb);
  const diskPct = diskTotal && diskNow !== null ? (diskNow / diskTotal) * 100 : null;
  const swapP95 = percentile(s.swap_used_mb || [], 0.95);

  const diskDaily = daily(buckets, s.disk_used_gb, mean);
  const memDaily = daily(buckets, s.mem_used_mb, (v) => percentile(v, 0.95));
  const cpuDaily = daily(buckets, s.cpu_pct, (v) => percentile(v, 0.95));
  const diskTrend = diskDaily.vals.length >= MIN_TREND_DAYS ? linreg(diskDaily.days, diskDaily.vals) : null;
  const memTrend = memDaily.vals.length >= MIN_TREND_DAYS ? linreg(memDaily.days, memDaily.vals) : null;
  const cpuTrend = cpuDaily.vals.length >= MIN_TREND_DAYS ? linreg(cpuDaily.days, cpuDaily.vals) : null;

  // "Base" = what the server uses that is NOT attributed to a tracked app (OS, DB, cache, ...).
  const mine = appReports.filter((a) => a.server_id === server.id && appSeries[a.id]);
  const baseCpu = usedCores.map((v, i) => {
    if (v === null) return null;
    const apps = mine.reduce((sum, a) => sum + (appSeries[a.id].cpu_pct[i] || 0) / 100, 0);
    return Math.max(0, v - apps);
  });
  const baseMem = s.mem_used_mb.map((v, i) => {
    if (v === null) return null;
    const apps = mine.reduce((sum, a) => sum + (appSeries[a.id].mem_mb[i] || 0), 0);
    return Math.max(0, v - apps);
  });

  const advice = [];
  let status = 'ok';
  const flag = (level, text) => {
    advice.push({ level, text });
    if (STATUS_RANK[level] > STATUS_RANK[status]) status = level;
  };

  const now = Math.floor((opts.now || Date.now()) / 1000);
  if (!server.last_seen || now - server.last_seen > opts.offlineAfter) {
    flag('offline', server.last_seen ? 'Agent non raggiungibile: nessun dato recente.' : 'Agent mai collegato.');
  }
  if (cpuP95 !== null) {
    if (cpuP95 >= 85) flag('critical', `CPU satura (p95 ${round(cpuP95)}%): aggiungi vCPU o sposta app su un altro server.`);
    else if (cpuP95 >= 70) flag('warning', `CPU elevata (p95 ${round(cpuP95)}%): margine ridotto nei picchi.`);
  }
  if (memP95Pct !== null) {
    if (memP95Pct >= 90) flag('critical', `RAM satura (p95 ${round(memP95Pct)}%): aggiungi memoria o sposta app.`);
    else if (memP95Pct >= 75) flag('warning', `RAM elevata (p95 ${round(memP95Pct)}%).`);
  }
  if (swapP95 !== null && swapP95 > 256) flag('warning', `Uso di swap significativo (p95 ${round(swapP95)} MB): segnale di RAM insufficiente.`);
  if (diskPct !== null) {
    if (diskPct >= 90) flag('critical', `Disco quasi pieno (${round(diskPct)}%).`);
    else if (diskPct >= 80) flag('warning', `Disco oltre l'80% (${round(diskPct)}%).`);
  }
  const diskDays = diskTotal ? daysUntil(diskNow, diskTrend && diskTrend.slope, diskTotal * 0.95) : null;
  if (diskDays !== null && diskDays < 30 && diskPct < 90) flag('warning', `Al ritmo attuale il disco si riempie in ~${Math.ceil(diskDays)} giorni.`);
  const memDays = memTotal ? daysUntil(lastValue(memDaily.vals), memTrend && memTrend.slope, memTotal * 0.9) : null;
  if (memDays !== null && memDays < 30 && memP95Pct < 90) flag('warning', `Trend RAM in crescita: soglia 90% stimata tra ~${Math.ceil(memDays)} giorni.`);
  const cpuDays = daysUntil(lastValue(cpuDaily.vals), cpuTrend && cpuTrend.slope, 85);
  if (cpuDays !== null && cpuDays < 30 && cpuP95 < 85) flag('warning', `Trend CPU in crescita: saturazione (85%) stimata tra ~${Math.ceil(cpuDays)} giorni.`);
  if (status === 'ok' && cpuP95 !== null && cpuP95 < 20 && memP95Pct !== null && memP95Pct < 40) {
    flag('info', 'Server sottoutilizzato: può ospitare altre app o essere ridimensionato.');
  }

  return {
    id: server.id,
    name: server.name,
    status,
    advice,
    capacity: { cpu_cores: cores, mem_mb: memTotal, disk_gb: diskTotal },
    cpu: { avg_pct: round(mean(s.cpu_pct)), p95_pct: round(cpuP95), max_pct: round(max(s.cpu_pct)), p95_cores: round(percentile(usedCores, 0.95), 2) },
    mem: { avg_mb: round(mean(s.mem_used_mb)), p95_mb: round(memP95), max_mb: round(max(s.mem_used_mb)), p95_pct: round(memP95Pct) },
    swap: { p95_mb: round(swapP95) },
    disk: {
      used_gb: round(diskNow, 2),
      pct: round(diskPct),
      growth_gb_per_day: diskTrend ? round(diskTrend.slope, 3) : null,
      days_to_full: diskDays === null ? null : round(diskDays, 0),
    },
    forecast: {
      mem_days_to_90pct: memDays === null ? null : round(memDays, 0),
      cpu_days_to_85pct: cpuDays === null ? null : round(cpuDays, 0),
    },
    base: {
      cpu_p95_cores: round(percentile(baseCpu, 0.95), 2),
      mem_p95_mb: round(percentile(baseMem, 0.95)),
    },
    _baseSeries: { cpu: baseCpu, mem: baseMem },
  };
}

function lastValue(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] !== null && arr[i] !== undefined && Number.isFinite(arr[i])) return arr[i];
  return null;
}

// ---------------------------------------------------------------------------
// Placement search
// ---------------------------------------------------------------------------
// Each server hosts base(t) + sum(apps assigned)(t). We compute p95 of the *summed* series
// (not sum of p95s) so apps whose peaks do not overlap can share a server.

function buildModel(serverReports, appReports, appSeries, T) {
  const servers = serverReports
    .filter((s) => s.capacity.cpu_cores && s.capacity.mem_mb)
    .map((s) => {
      const baseCpu = s._baseSeries.cpu;
      const baseMem = s._baseSeries.mem;
      const medCpu = percentile(baseCpu, 0.5) || 0;
      const medMem = percentile(baseMem, 0.5) || 0;
      return {
        id: s.id,
        name: s.name,
        virtual: false,
        cores: s.capacity.cpu_cores,
        mem: s.capacity.mem_mb,
        baseCpu: Float64Array.from(fillGaps(baseCpu.length ? baseCpu : new Array(T).fill(null), medCpu)),
        baseMem: Float64Array.from(fillGaps(baseMem.length ? baseMem : new Array(T).fill(null), medMem)),
      };
    });
  const apps = appReports
    .filter((a) => a.samples > 0 && appSeries[a.id])
    .map((a) => ({
      id: a.id,
      name: a.name,
      home: a.server_id,
      cpu: Float64Array.from(appSeries[a.id].cpu_pct.map((v) => (v === null ? 0 : v / 100))),
      mem: Float64Array.from(appSeries[a.id].mem_mb.map((v) => (v === null ? 0 : v))),
      weight: (a.cpu.p95_cores || 0) + (a.mem.p95_mb || 0) / 1024,
    }));
  return { servers, apps, T };
}

function evaluate(model, assign, headroom) {
  const { servers, apps, T } = model;
  const per = servers.map((s) => ({ cpu: Float64Array.from(s.baseCpu), mem: Float64Array.from(s.baseMem), apps: [] }));
  apps.forEach((a, i) => {
    const p = per[assign[i]];
    p.apps.push(i);
    for (let t = 0; t < T; t++) {
      p.cpu[t] += a.cpu[t];
      p.mem[t] += a.mem[t];
    }
  });
  let peak = 0;
  let overflow = 0;
  const utils = [];
  const detail = per.map((p, si) => {
    const s = servers[si];
    const cpuP95 = percentile(Array.from(p.cpu), 0.95) || 0;
    const memP95 = percentile(Array.from(p.mem), 0.95) || 0;
    const cu = cpuP95 / s.cores;
    const mu = memP95 / s.mem;
    const u = Math.max(cu, mu);
    utils.push(u);
    peak = Math.max(peak, u);
    overflow += Math.max(0, cu - headroom) + Math.max(0, mu - headroom);
    return { si, cpu_p95_cores: cpuP95, mem_p95_mb: memP95, cpu_util: cu, mem_util: mu, apps: p.apps };
  });
  // Empty virtual servers cost nothing; a used virtual server is a strong penalty (buying hardware).
  const usedVirtual = per.filter((p, si) => servers[si].virtual && p.apps.length).length;
  const avg = utils.reduce((s, u) => s + u, 0) / utils.length;
  const imbalance = Math.sqrt(utils.reduce((s, u) => s + (u - avg) ** 2, 0) / utils.length);
  const moves = apps.reduce((n, a, i) => n + (servers[assign[i]].id !== a.home ? 1 : 0), 0);
  const score = peak + 0.15 * imbalance + 0.02 * moves + 10 * overflow + 0.5 * usedVirtual;
  return { score, peak, overflow, imbalance, moves, feasible: overflow === 0, detail };
}

function* allAssignments(nApps, nServers) {
  const a = new Array(nApps).fill(0);
  while (true) {
    yield a.slice();
    let i = 0;
    while (i < nApps && ++a[i] === nServers) a[i++] = 0;
    if (i === nApps) return;
  }
}

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function search(model, headroom, n, budget = 6000) {
  const { servers, apps } = model;
  const seen = new Map();
  const consider = (assign) => {
    const key = assign.join(',');
    if (seen.has(key)) return seen.get(key);
    const r = evaluate(model, assign, headroom);
    r.assign = assign.slice();
    seen.set(key, r);
    return r;
  };
  if (!apps.length || !servers.length) return [];

  const space = servers.length ** apps.length;
  if (space <= budget) {
    for (const a of allAssignments(apps.length, servers.length)) consider(a);
  } else {
    const idxOf = new Map(servers.map((s, i) => [s.id, i]));
    const current = apps.map((a) => (idxOf.has(a.home) ? idxOf.get(a.home) : 0));
    const starts = [current];
    // Greedy: heaviest app first onto the server with the lowest resulting peak.
    const order = apps.map((_, i) => i).sort((x, y) => apps[y].weight - apps[x].weight);
    const greedy = new Array(apps.length).fill(0);
    const placed = [];
    for (const i of order) {
      let best = null;
      for (let s = 0; s < servers.length; s++) {
        greedy[i] = s;
        const sub = { ...model, apps: placed.concat([i]).map((k) => apps[k]) };
        const r = evaluate(sub, placed.concat([i]).map((k) => greedy[k]), headroom);
        if (!best || r.score < best.score) best = { s, score: r.score };
      }
      greedy[i] = best.s;
      placed.push(i);
    }
    starts.push(greedy);
    const rnd = mulberry32(42);
    for (let k = 0; k < 8; k++) starts.push(apps.map(() => Math.floor(rnd() * servers.length)));

    for (const start of starts) {
      let cur = consider(start);
      let improved = true;
      while (improved && seen.size < budget) {
        improved = false;
        for (let i = 0; i < apps.length && seen.size < budget; i++) {
          for (let s = 0; s < servers.length; s++) {
            if (s === cur.assign[i]) continue;
            const cand = cur.assign.slice();
            cand[i] = s;
            const r = consider(cand);
            if (r.score < cur.score - 1e-9) {
              cur = r;
              improved = true;
            }
          }
        }
        // pairwise swaps
        for (let i = 0; i < apps.length && seen.size < budget; i++) {
          for (let j = i + 1; j < apps.length; j++) {
            if (cur.assign[i] === cur.assign[j]) continue;
            const cand = cur.assign.slice();
            [cand[i], cand[j]] = [cand[j], cand[i]];
            const r = consider(cand);
            if (r.score < cur.score - 1e-9) {
              cur = r;
              improved = true;
            }
          }
        }
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.score - b.score).slice(0, n);
}

function describe(model, r, rank) {
  const { servers, apps } = model;
  return {
    rank,
    score: round(r.score, 4),
    feasible: r.feasible,
    peak_util_pct: round(r.peak * 100),
    imbalance: round(r.imbalance, 3),
    requires_new_server: r.detail.some((d) => servers[d.si].virtual && d.apps.length),
    moves: apps
      .map((a, i) => ({ app_id: a.id, app: a.name, from: a.home, to: servers[r.assign[i]].id, to_name: servers[r.assign[i]].name }))
      .filter((m) => m.from !== m.to),
    servers: r.detail
      .filter((d) => !servers[d.si].virtual || d.apps.length)
      .map((d) => ({
        id: servers[d.si].id,
        name: servers[d.si].name,
        virtual: servers[d.si].virtual,
        capacity: { cpu_cores: servers[d.si].cores, mem_mb: servers[d.si].mem },
        apps: d.apps.map((i) => apps[i].name),
        cpu_p95_cores: round(d.cpu_p95_cores, 2),
        cpu_p95_pct: round(d.cpu_util * 100),
        mem_p95_mb: round(d.mem_p95_mb),
        mem_p95_pct: round(d.mem_util * 100),
      })),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * @param input {{ buckets:number[], servers:object[], apps:object[],
 *                 serverSeries:Object<number,{cpu_pct,mem_used_mb,disk_used_gb,swap_used_mb}>,
 *                 appSeries:Object<number,{cpu_pct,mem_mb}> }}
 * @param opts {{ headroom?:number, n?:number, now?:number, offlineAfter?:number }}
 */
function analyze(input, opts = {}) {
  const o = { headroom: 0.8, n: 5, offlineAfter: 300, ...opts };
  const { buckets, servers, apps, serverSeries, appSeries } = input;
  const T = buckets.length;
  const empty = { cpu_pct: new Array(T).fill(null), mem_used_mb: new Array(T).fill(null), disk_used_gb: new Array(T).fill(null), swap_used_mb: new Array(T).fill(null) };

  const appReports = apps.map((a) => analyzeApp(a, appSeries[a.id] || { cpu_pct: new Array(T).fill(null), mem_mb: new Array(T).fill(null) }, buckets));
  const serverReports = servers.map((s) => analyzeServer(s, serverSeries[s.id] || empty, appReports, buckets, appSeries, o));

  const model = buildModel(serverReports, appReports, appSeries, T);
  const currentAssign = model.apps.map((a) => Math.max(0, model.servers.findIndex((s) => s.id === a.home)));
  const current = model.apps.length && model.servers.length ? evaluate(model, currentAssign, o.headroom) : null;
  if (current) current.assign = currentAssign;

  let results = search(model, o.headroom, o.n);
  let expansion = null;
  if (model.servers.length && model.apps.length && (!results.length || !results[0].feasible)) {
    // No feasible placement on existing hardware -> try with one extra server sized like the largest one.
    const biggest = model.servers.reduce((a, b) => (b.cores * 1024 + b.mem > a.cores * 1024 + a.mem ? b : a));
    const minBaseCpu = Math.min(...model.servers.map((s) => percentile(Array.from(s.baseCpu), 0.5) || 0));
    const minBaseMem = Math.min(...model.servers.map((s) => percentile(Array.from(s.baseMem), 0.5) || 0));
    const virtual = { id: -1, name: 'Nuovo server', virtual: true, cores: biggest.cores, mem: biggest.mem, baseCpu: new Float64Array(T).fill(minBaseCpu), baseMem: new Float64Array(T).fill(minBaseMem) };
    const model2 = { ...model, servers: model.servers.concat([virtual]) };
    const results2 = search(model2, o.headroom, o.n);
    expansion = { cpu_cores: biggest.cores, mem_mb: biggest.mem, feasible: !!(results2[0] && results2[0].feasible) };
    results = results2;
    results.model = model2;
  }
  const usedModel = results.model || model;

  // Fleet totals
  const totCores = sum(serverReports.map((s) => s.capacity.cpu_cores));
  const totMem = sum(serverReports.map((s) => s.capacity.mem_mb));
  const usedCores = sum(serverReports.map((s) => s.cpu.p95_cores));
  const usedMem = sum(serverReports.map((s) => s.mem.p95_mb));
  const fleetAdvice = [];
  let verdict = 'ok';
  if (!model.apps.length) {
    verdict = 'no_data';
    fleetAdvice.push('Dati insufficienti: servono metriche delle app per calcolare le combinazioni.');
  } else if (expansion) {
    verdict = 'expand';
    const needCores = Math.max(0, usedCores / o.headroom - totCores);
    const needMem = Math.max(0, usedMem / o.headroom - totMem);
    fleetAdvice.push(
      `Con le risorse attuali non esiste una distribuzione che resti sotto il ${Math.round(o.headroom * 100)}% nei picchi: serve allargare il servizio.`
    );
    fleetAdvice.push(
      `Stima minima: +${Math.ceil(needCores)} vCPU e +${Math.ceil(needMem / 1024)} GB RAM complessivi (es. un server da ${expansion.cpu_cores} vCPU / ${Math.round(expansion.mem_mb / 1024)} GB).`
    );
  } else if (current && !current.feasible) {
    verdict = 'rebalance';
    fleetAdvice.push('La distribuzione attuale supera la soglia su almeno un server, ma esiste una ridistribuzione che rientra: vedi le combinazioni proposte.');
  } else if (current && results[0] && results[0].score < current.score - 0.05) {
    verdict = 'optimize';
    fleetAdvice.push('La distribuzione attuale regge, ma una ridistribuzione bilancerebbe meglio il carico.');
  } else {
    fleetAdvice.push('La distribuzione attuale è adeguata.');
  }

  for (const s of serverReports) delete s._baseSeries;
  return {
    generated_at: new Date(o.now || Date.now()).toISOString(),
    params: { headroom: o.headroom, n: o.n, bucket_seconds: T > 1 ? buckets[1] - buckets[0] : null, from: buckets[0] || null, to: buckets[T - 1] || null },
    fleet: {
      verdict,
      advice: fleetAdvice,
      capacity: { cpu_cores: totCores, mem_mb: totMem },
      usage_p95: { cpu_cores: round(usedCores, 2), mem_mb: round(usedMem) },
      expansion,
    },
    servers: serverReports,
    apps: appReports,
    current: current ? describe(model, current, 0) : null,
    combinations: results.map((r, i) => describe(usedModel, r, i + 1)),
  };
}

function sum(arr) {
  return arr.reduce((s, v) => s + (v || 0), 0);
}

module.exports = { analyze, percentile, linreg, mean, evaluate, buildModel };
