'use strict';
// First-access passwords chosen by the console for new portals.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zdt-cred-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.ADMIN_PASSWORD = 'secret-pass';
process.env.CREDENTIALS_KEY = 'a'.repeat(64);
const { server, db } = require('../server/index');
const { generatePassword } = require('../server/credentials');

let base;
function client() {
  let cookie = '';
  return async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', cookie, ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('generated passwords are long and unambiguous', () => {
  const pw = generatePassword();
  assert.equal(pw.length, 16);
  assert.match(pw, /^[a-km-zA-HJ-NP-Z2-9]+$/);
  assert.notEqual(generatePassword(), generatePassword());
});

test('initial password: chosen by the console, delivered once, shown only when applied', async () => {
  const admin = client();
  await admin('POST', '/api/login', { username: 'admin', password: 'secret-pass' });
  const srv = (await admin('POST', '/api/servers', { name: 'zerodarkserver' })).body;
  const agent = (body) => admin('POST', '/api/agent/report', body || { samples: [] }, { authorization: `Bearer ${srv.token}` });

  await admin('POST', `/api/servers/${srv.id}/apps`, { type: 'portal', name: 'rossi', email: 'mario@rossi.it' });
  const task = (await agent()).body.tasks[0];
  const pw = task.payload.admin_password;
  assert.equal(typeof pw, 'string');
  assert.equal(pw.length, 16);

  // never stored in clear: not in the task payload, not anywhere in the database file
  const stored = db.prepare('SELECT payload FROM tasks WHERE id = ?').get(task.id).payload;
  assert.ok(!stored.includes(pw), 'task payload must not contain the password');
  db.exec('PRAGMA wal_checkpoint(FULL)');
  assert.ok(!fs.readFileSync(process.env.DB_FILE).includes(Buffer.from(pw)), 'database must not contain the password in clear');

  let app = (await admin('GET', `/api/servers/${srv.id}`)).body.apps.find((a) => a.name === 'rossi');
  assert.equal(app.credentials.status, 'pending');
  assert.equal((await admin('GET', `/api/apps/${app.id}/credentials`)).body.password, undefined, 'not shown before the portal exists');

  // create_app confirms it used the password
  await admin('POST', `/api/agent/tasks/${task.id}`, { status: 'done', message: 'Gestionale creato', app: { kind: 'docker', match: '^zd-sq-rossi-', admin_password: 'applied' } }, { authorization: `Bearer ${srv.token}` });
  const shown = (await admin('GET', `/api/apps/${app.id}/credentials`)).body;
  assert.deepEqual([shown.status, shown.username, shown.password, shown.login_url], ['applied', 'mario@rossi.it', pw, 'https://rossi.zerodarkteam.it/login']);
  app = (await admin('GET', `/api/servers/${srv.id}`)).body.apps.find((a) => a.name === 'rossi');
  assert.equal(app.credentials.revealed_by, 'admin', 'each view is recorded');
  assert.ok(!JSON.stringify(app).includes(pw), 'server detail never carries the password');

  // read-only users never see it
  await admin('POST', '/api/users', { username: 'viewer', password: 'viewer-pass', role: 'viewer' });
  const viewer = client();
  await viewer('POST', '/api/login', { username: 'viewer', password: 'viewer-pass' });
  assert.equal((await viewer('GET', `/api/apps/${app.id}/credentials`)).status, 403);

  // a create_app that does not confirm: the console must not show a password that may be wrong
  await admin('POST', `/api/servers/${srv.id}/apps`, { type: 'portal', name: 'bianchi', email: 'a@b.it' });
  const t2 = (await agent()).body.tasks[0];
  await admin('POST', `/api/agent/tasks/${t2.id}`, { status: 'done', message: 'ok', app: { kind: 'docker', match: '^zd-sq-bianchi-' } }, { authorization: `Bearer ${srv.token}` });
  const b = (await admin('GET', `/api/servers/${srv.id}`)).body.apps.find((a) => a.name === 'bianchi');
  const r = (await admin('GET', `/api/apps/${b.id}/credentials`)).body;
  assert.equal(r.status, 'unsupported');
  assert.equal(r.password, undefined);

  // services never get one
  await admin('POST', `/api/servers/${srv.id}/apps`, { type: 'service', name: 'cache', kind: 'docker' });
  const t3 = (await agent()).body.tasks[0];
  assert.equal(t3.payload.admin_password, undefined);
});
