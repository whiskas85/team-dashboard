'use strict';
// Portal creation follows the gestionale's create_app contract (deploy/console-hooks in whiskas85/team-management).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zdt-portal-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.ADMIN_PASSWORD = 'secret-pass';
const { server, db } = require('../server/index');

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

test('portal creation contract', async () => {
  await call('POST', '/api/login', { username: 'admin', password: 'secret-pass' });
  const srv = (await call('POST', '/api/servers', { name: 'zerodarkserver' })).body;
  const create = (body) => call('POST', `/api/servers/${srv.id}/apps`, { type: 'portal', ...body });

  for (const name of ['ops', 'www', 'test', 'test2', 'testing']) {
    const r = await create({ name });
    assert.equal(r.status, 400, `${name} must be reserved`);
    assert.match(r.body.error, /riservato/);
  }
  assert.equal((await create({ name: 'Demo' })).status, 400, 'uppercase is not a valid subdomain');
  assert.equal((await create({ name: 'de_mo' })).status, 400);
  assert.equal((await create({ name: 'demo', domain: 'zerodarkteam.it' })).status, 400, 'bare domain is reserved');
  assert.equal((await create({ name: 'demo', email: 'not-an-email' })).status, 400);

  const ok = await create({ name: 'demo', email: 'admin@example.com' });
  assert.equal(ok.status, 200);
  const app = (await call('GET', `/api/servers/${srv.id}`)).body.apps.find((a) => a.name === 'demo');
  assert.equal(app.domain, 'demo.zerodarkteam.it', 'default domain');
  assert.equal(app.kind, 'docker');
  assert.equal(app.match, '^zd-sq-demo-', 'monitored before the hook even runs');
  assert.ok('health' in app, 'health column migrated');

  // the agent receives domain + email for ZDT_APP_DOMAIN / ZDT_APP_EMAIL
  const rep = await call('POST', '/api/agent/report', { samples: [] }, { authorization: `Bearer ${srv.token}` });
  const task = rep.body.tasks[0];
  assert.equal(task.action, 'create_app');
  assert.deepEqual([task.payload.name, task.payload.domain, task.payload.email], ['demo', 'demo.zerodarkteam.it', 'admin@example.com']);

  // a custom domain is kept (lowercased); services keep the free-form rules
  assert.equal((await create({ name: 'rossi', domain: 'Gestionale.Rossi.IT' })).status, 200);
  const rossi = (await call('GET', `/api/servers/${srv.id}`)).body.apps.find((a) => a.name === 'rossi');
  assert.equal(rossi.domain, 'gestionale.rossi.it');
  assert.equal((await call('POST', `/api/servers/${srv.id}/apps`, { type: 'service', name: 'Ops_Api', kind: 'systemd', provision: false })).status, 200);
});
