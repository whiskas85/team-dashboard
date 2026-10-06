'use strict';
// Gestionale versions and updates: list_versions / update_app hooks (whiskas85/team-management).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zdt-updates-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.ADMIN_PASSWORD = 'secret-pass';
const { server, db } = require('../server/index');
const { Updates, cmpVersion } = require('../server/updates');
const { tx } = require('../server/db');

let base;
let cookie = '';
async function call(method, p, body, headers = {}) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}

test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('version ordering', () => {
  assert.ok(cmpVersion('3.10.0', '3.9.9') > 0);
  assert.ok(cmpVersion('3.24.0', '3.25.0') < 0);
  assert.equal(cmpVersion('3.25.0', '3.25.0'), 0);
});

test('updates of the gestionale squads', async () => {
  await call('POST', '/api/login', { username: 'admin', password: 'secret-pass' });
  const srv = (await call('POST', '/api/servers', { name: 'zerodarkserver' })).body;
  const auth = { authorization: `Bearer ${srv.token}` };
  const report = async () => (await call('POST', '/api/agent/report', { agent_version: '0.1.3', samples: [] }, auth)).body.tasks;
  const ack = (t, status, app, message = '') => call('POST', `/api/agent/tasks/${t.id}`, { status, message, app }, auth);

  for (const name of ['rossi', 'verdi']) await call('POST', `/api/servers/${srv.id}/apps`, { type: 'portal', name, email: 'a@b.it' });
  for (const t of await report()) await ack(t, 'done', { kind: 'docker', match: `^zd-sq-${t.payload.name}-`, admin_password: 'applied' });
  // production portal: never updated by the console
  await call('POST', '/api/agent/report', { samples: [{ system: { cpu_pct: 1 }, apps: [{ name: 'gestionale', kind: 'docker', match: '^zd-(app|db)$', cpu_pct: 1, mem_mb: 100 }] }] }, auth);
  const prodId = (await call('GET', `/api/servers/${srv.id}`)).body.apps.find((a) => a.name === 'gestionale').id;
  await call('PATCH', `/api/apps/${prodId}`, { type: 'portal', domain: 'ops.zerodarkteam.it' });
  const apps = (await call('GET', `/api/servers/${srv.id}`)).body.apps;
  const rossi = apps.find((a) => a.name === 'rossi');
  const verdi = apps.find((a) => a.name === 'verdi');
  const prod = apps.find((a) => a.name === 'gestionale');
  assert.equal(prod.update, null, 'no update controls for production');
  assert.equal(rossi.update.latest, null);

  // Ask the server: one list_versions for the server, one per squad whose version is unknown
  assert.equal((await call('POST', '/api/updates/check')).body.servers, 1);
  let tasks = await report();
  assert.deepEqual(tasks.map((t) => [t.action, t.payload.name || null]).sort(), [['list_versions', null], ['list_versions', 'rossi'], ['list_versions', 'verdi']]);
  for (const t of tasks) {
    await ack(t, 'done', { available: ['3.24.0', '3.25.0', 'latest'], latest: '3.25.0', ...(t.payload.name ? { current: t.payload.name === 'rossi' ? '3.24.0' : '3.25.0' } : {}) });
  }
  let info = (await call('GET', `/api/apps/${rossi.id}/updates`)).body;
  assert.deepEqual([info.version, info.latest, info.available], ['3.24.0', '3.25.0', ['3.25.0', '3.24.0']]);
  assert.equal(info.update.behind, true);
  assert.equal((await call('GET', `/api/apps/${verdi.id}/updates`)).body.update.behind, false);

  // Manual updates: validated, only squads, one at a time
  assert.equal((await call('POST', `/api/apps/${rossi.id}/update`, { version: 'latest' })).status, 400);
  assert.equal((await call('POST', `/api/apps/${prod.id}/update`, { version: '3.25.0' })).status, 400);
  assert.equal((await call('POST', `/api/apps/${rossi.id}/update`, { version: '3.25.0' })).body.status, 'queued');
  assert.match((await call('POST', `/api/apps/${rossi.id}/update`, { version: '3.25.0' })).body.error, /già in corso/);
  assert.equal((await call('POST', `/api/apps/${verdi.id}/update`, { version: '3.24.0' })).body.status, 'queued', 'going back is allowed');

  // The server runs one update at a time
  tasks = await report();
  assert.equal(tasks.filter((t) => t.action === 'update_app').length, 1);
  const first = tasks.find((t) => t.action === 'update_app');
  assert.deepEqual([first.payload.name, first.payload.version, first.payload.by], ['rossi', '3.25.0', 'admin']);
  assert.equal((await report()).length, 0, 'the second waits for the first');
  assert.equal((await call('GET', `/api/servers/${srv.id}`)).body.apps.find((a) => a.name === 'rossi').update.running.version, '3.25.0');
  await ack(first, 'done', { version: '3.25.0', previous: '3.24.0' }, '== rossi: versione 3.25.0, il gestionale risponde');
  info = (await call('GET', `/api/apps/${rossi.id}/updates`)).body;
  assert.deepEqual([info.version, info.update.behind, info.update.running, info.history[0].status, info.history[0].from], ['3.25.0', false, null, 'done', '3.24.0']);

  // Roll back: the hook brings the old version back and fails; the console keeps the truth
  const second = (await report()).find((t) => t.action === 'update_app');
  assert.equal(second.payload.name, 'verdi');
  await ack(second, 'failed', { version: '3.25.0', attempted: '3.24.0', rolled_back: true }, '!! verdi non risponde con la 3.24.0');
  info = (await call('GET', `/api/apps/${verdi.id}/updates`)).body;
  assert.deepEqual([info.version, info.history[0].rolled_back, info.history[0].status], ['3.25.0', true, 'failed']);
  assert.equal((await call('GET', `/api/servers/${srv.id}`)).body.apps.find((a) => a.name === 'verdi').update.last.rolled_back, true);

  // Update all: every squad behind the latest version
  db.prepare("UPDATE apps SET version = '3.24.0' WHERE id = ?").run(rossi.id);
  assert.deepEqual((await call('POST', '/api/updates/all')).body.queued, ['rossi']);
  const third = (await report()).find((t) => t.action === 'update_app');
  await ack(third, 'done', { version: '3.25.0', previous: '3.24.0' });

  // Automatic updates: at the configured local hour, only opted-in squads, never a version that failed
  assert.equal((await call('POST', `/api/apps/${prod.id}/auto-update`, { enabled: true })).status, 400);
  assert.equal((await call('POST', `/api/apps/${rossi.id}/auto-update`, { enabled: true })).body.auto_update, true);
  assert.equal((await call('POST', `/api/apps/${verdi.id}/auto-update`, { enabled: true })).body.auto_update, true);
  db.prepare("UPDATE servers SET versions = ? WHERE id = ?").run(JSON.stringify({ available: ['3.26.0', '3.25.0'], latest: '3.26.0' }), srv.id);
  db.prepare("UPDATE tasks SET created_at = created_at - 86400 WHERE action = 'update_app'").run();
  db.prepare("INSERT INTO tasks (server_id, app_id, action, payload, status, created_at, updated_at) VALUES (?, ?, 'update_app', ?, 'failed', 0, 0)").run(srv.id, verdi.id, JSON.stringify({ name: 'verdi', version: '3.26.0' }));
  const u = new Updates(db, { now: () => Math.floor(Date.now() / 1000), tx, hour: 4, timeZone: 'Europe/Rome' });
  assert.deepEqual(u.autoUpdate(new Date('2026-10-06T12:00:00Z')), [], 'not at 14:00 in Rome');
  assert.deepEqual(u.autoUpdate(new Date('2026-10-06T02:30:00Z')), ['rossi'], '04:30 in Rome; verdi already failed 3.26.0');
  assert.deepEqual(u.autoUpdate(new Date('2026-10-06T02:35:00Z')), [], 'once');
  const auto = (await report()).find((t) => t.action === 'update_app');
  assert.deepEqual([auto.payload.name, auto.payload.version, auto.payload.auto], ['rossi', '3.26.0', true]);
  assert.equal((await call('GET', '/api/apps?view=portals')).body.find((a) => a.name === 'rossi').update.checked_at > 0, true);

  // Production released 3.27.0 (seen by the health check): the server's list is asked again by itself
  await ack(auto, 'done', { version: '3.26.0', previous: '3.25.0' });
  db.prepare('UPDATE servers SET versions_at = versions_at - 3600 WHERE id = ?').run(srv.id);
  u.setVersion(prod.id, '3.27.0');
  assert.ok((await report()).some((t) => t.action === 'list_versions' && !t.payload.name), 'stale list refreshed');
  u.setVersion(prod.id, '3.27.0');
  assert.equal((await report()).length, 0, 'once');
});
