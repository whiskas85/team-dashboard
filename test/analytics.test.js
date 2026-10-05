'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze, percentile, linreg } = require('../server/analytics');

test('percentile & linreg basics', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([null, 10], 0.95), 10);
  assert.equal(percentile([], 0.5), null);
  const r = linreg([0, 1, 2, 3], [1, 3, 5, 7]);
  assert.equal(r.slope, 2);
});

// Two servers of 4 cores / 8 GB. Server A hosts two apps peaking at the same hour (overloaded),
// server B hosts nothing. The engine must propose moving one of them.
function scenario({ cores = 4, mem = 8192, appCpu = 1.8, appMem = 3000, nApps = 2 } = {}) {
  const T = 96;
  const buckets = Array.from({ length: T }, (_, i) => 1_700_000_000 + i * 900);
  const peak = (i) => (i % 24 < 6 ? 1 : 0.2);
  const apps = [];
  const appSeries = {};
  for (let k = 0; k < nApps; k++) {
    apps.push({ id: 10 + k, name: `ops-${k}`, server_id: 1, type: 'portal', status: 'active' });
    appSeries[10 + k] = { cpu_pct: buckets.map((_, i) => appCpu * peak(i) * 100), mem_mb: buckets.map(() => appMem) };
  }
  const sumCpu = (i) => apps.reduce((s, a) => s + appSeries[a.id].cpu_pct[i] / 100, 0) + 0.2;
  const sumMem = () => apps.length * appMem + 500;
  const serverSeries = {
    1: { cpu_pct: buckets.map((_, i) => Math.min(100, (sumCpu(i) / cores) * 100)), mem_used_mb: buckets.map(sumMem), disk_used_gb: buckets.map(() => 20), swap_used_mb: buckets.map(() => 0) },
    2: { cpu_pct: buckets.map(() => (0.2 / cores) * 100), mem_used_mb: buckets.map(() => 500), disk_used_gb: buckets.map(() => 10), swap_used_mb: buckets.map(() => 0) },
  };
  const t = buckets[T - 1];
  const servers = [
    { id: 1, name: 'a', cpu_cores: cores, mem_total_mb: mem, disk_total_gb: 80, last_seen: t },
    { id: 2, name: 'b', cpu_cores: cores, mem_total_mb: mem, disk_total_gb: 80, last_seen: t },
  ];
  return { input: { buckets, servers, apps, serverSeries, appSeries }, now: t * 1000 };
}

test('proposes rebalancing an overloaded server', () => {
  const { input, now } = scenario();
  const r = analyze(input, { headroom: 0.8, n: 3, now });
  assert.equal(r.current.feasible, false, 'current layout should exceed headroom');
  assert.equal(r.fleet.verdict, 'rebalance');
  const best = r.combinations[0];
  assert.equal(best.feasible, true);
  assert.equal(best.moves.length, 1);
  assert.ok(best.servers.every((s) => s.apps.length === 1));
  const a = r.servers.find((s) => s.id === 1);
  assert.ok(['warning', 'critical'].includes(a.status));
  assert.ok(Math.abs(a.base.cpu_p95_cores - 0.2) < 0.05, 'base load excludes app usage');
});

test('asks to expand when nothing fits', () => {
  const { input, now } = scenario({ appCpu: 3.5, appMem: 6000, nApps: 3 });
  const r = analyze(input, { headroom: 0.8, n: 3, now });
  assert.equal(r.fleet.verdict, 'expand');
  assert.ok(r.fleet.expansion);
  assert.ok(r.combinations[0].servers.some((s) => s.virtual));
});

test('uses local search on larger fleets', () => {
  const { input, now } = scenario({ appCpu: 0.3, appMem: 400, nApps: 16 });
  const r = analyze(input, { headroom: 0.8, n: 5, now });
  assert.equal(r.combinations.length, 5);
  assert.ok(r.combinations[0].feasible);
  assert.ok(r.combinations[0].score <= r.combinations[4].score);
});

test('handles empty input', () => {
  const r = analyze({ buckets: [], servers: [], apps: [], serverSeries: {}, appSeries: {} });
  assert.equal(r.fleet.verdict, 'no_data');
  assert.deepEqual(r.combinations, []);
});
