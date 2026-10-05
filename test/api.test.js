'use strict';
// End-to-end: admin creates a server, agent reports, admin creates an app, agent receives & acks the task.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zdt-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.ADMIN_PASSWORD = 'secret';
process.env.EXPORT_TOKEN = 'export-tok';
process.env.RETENTION_DAYS = '30';
const { server, db } = require('../server/index');

let base;
let cookie = '';
async function call(method, p, body, headers = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', cookie, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}

test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('full flow', async () => {
  assert.equal((await call('GET', '/api/servers')).status, 401);
  assert.equal((await call('POST', '/api/login', { password: 'nope' })).status, 401);
  assert.equal((await call('POST', '/api/login', { password: 'secret' })).status, 200);

  const created = await call('POST', '/api/servers', { name: 'ops-01' });
  assert.equal(created.status, 200);
  assert.match(created.body.install, /install\.sh/);
  const token = created.body.token;
  const auth = { authorization: `Bearer ${token}` };

  assert.equal((await call('POST', '/api/agent/report', {}, { authorization: 'Bearer bad' })).status, 401);

  const now = Math.floor(Date.now() / 1000);
  const sample = (ts) => ({ ts, system: { cpu_pct: 40, load: [1, 1, 1], mem_used_mb: 3000, disk_used_gb: 20, disk_total_gb: 80 }, apps: [{ name: 'ops-acme', kind: 'docker', cpu_pct: 120, mem_mb: 900, procs: 3 }] });
  const rep = await call('POST', '/api/agent/report', { hostname: 'h1', cpu_cores: 4, mem_total_mb: 8192, disk_total_gb: 80, samples: [sample(now - 120), sample(now - 60), sample(now - 40 * 86400)] }, auth);
  assert.equal(rep.status, 200);
  assert.equal(rep.body.stored, 2, 'samples older than retention are dropped');
  assert.deepEqual(rep.body.apps.map((a) => a.name), ['ops-acme'], 'unknown app is auto-registered');

  const list = await call('GET', '/api/servers');
  assert.equal(list.body[0].online, true);
  assert.equal(list.body[0].cpu_cores, 4);

  const app = await call('POST', `/api/servers/${created.body.id}/apps`, { name: 'ops-new', type: 'portal', kind: 'docker', domain: 'new.zerodarkteam.it', port: 8081 });
  assert.equal(app.body.status, 'pending');
  assert.equal((await call('POST', `/api/servers/${created.body.id}/apps`, { name: 'bad name!' })).status, 400);

  const rep2 = await call('POST', '/api/agent/report', sample(now), auth);
  assert.equal(rep2.body.tasks.length, 1);
  const task = rep2.body.tasks[0];
  assert.equal(task.action, 'create_app');
  assert.equal(task.payload.domain, 'new.zerodarkteam.it');
  const rep3 = await call('POST', '/api/agent/report', sample(now), auth);
  assert.equal(rep3.body.tasks.length, 0, 'task is not re-sent immediately');

  await call('POST', `/api/agent/tasks/${task.id}`, { status: 'done', message: 'ok', app: { kind: 'docker', match: '^ops-new-' } }, auth);
  const detail = await call('GET', `/api/servers/${created.body.id}`);
  const created2 = detail.body.apps.find((a) => a.name === 'ops-new');
  assert.equal(created2.status, 'active');
  assert.equal(created2.match, '^ops-new-');

  const metrics = await call('GET', `/api/servers/${created.body.id}/metrics?range=1h`);
  assert.ok(metrics.body.rows.length >= 1);

  const analysis = await call('GET', '/api/analysis?days=7');
  assert.equal(analysis.status, 200);
  assert.equal(analysis.body.servers.length, 1);

  cookie = '';
  assert.equal((await call('GET', '/api/v1/export')).status, 401);
  const exp = await call('GET', '/api/v1/export?days=7', null, { authorization: 'Bearer export-tok' });
  assert.equal(exp.status, 200);
  assert.equal(exp.body.schema, 'zerodark.console.capacity/v1');
});
