'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zdt-users-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.ADMIN_PASSWORD = 'bootstrap-pass';
const { server, db } = require('../server/index');

let base;
function client() {
  let cookie = '';
  return async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('default admin, viewer role, password change and session invalidation', async () => {
  const admin = client();
  assert.equal((await admin('POST', '/api/login', { username: 'admin', password: 'wrong' })).status, 401);
  const login = await admin('POST', '/api/login', { username: 'admin', password: 'bootstrap-pass' });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, 'admin');

  // create a read-only user
  assert.equal((await admin('POST', '/api/users', { username: 'mario', password: 'short', role: 'viewer' })).status, 400);
  const created = await admin('POST', '/api/users', { username: 'mario', password: 'password-mario', role: 'viewer' });
  assert.equal(created.status, 200);
  assert.equal((await admin('POST', '/api/users', { username: 'MARIO', password: 'password-mario' })).status, 409, 'usernames are case-insensitive');

  const viewer = client();
  assert.equal((await viewer('POST', '/api/login', { username: 'mario', password: 'password-mario' })).status, 200);
  assert.equal((await viewer('GET', '/api/servers')).status, 200, 'viewer can read');
  assert.equal((await viewer('POST', '/api/servers', { name: 'x' })).status, 403, 'viewer cannot write');
  assert.equal((await viewer('GET', '/api/users')).status, 403);

  // viewer changes own username + password; old password stops working
  assert.equal((await viewer('PATCH', '/api/me', { current_password: 'nope', new_password: 'another-pass' })).status, 400);
  const changed = await viewer('PATCH', '/api/me', { current_password: 'password-mario', username: 'mario.rossi', new_password: 'another-pass' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.user.username, 'mario.rossi');
  assert.equal((await viewer('GET', '/api/me')).body.authenticated, true, 'current browser stays signed in');
  assert.equal((await client()('POST', '/api/login', { username: 'mario.rossi', password: 'password-mario' })).status, 401);

  // admin resets the viewer password: the viewer's open session is invalidated
  await admin('PATCH', `/api/users/${created.body.id}`, { password: 'reset-by-admin' });
  assert.equal((await viewer('GET', '/api/servers')).status, 401);

  // the last admin cannot be demoted or deleted; admin cannot delete itself
  const me = (await admin('GET', '/api/me')).body.user;
  assert.equal((await admin('PATCH', `/api/users/${me.id}`, { role: 'viewer' })).status, 400);
  assert.equal((await admin('DELETE', `/api/users/${me.id}`)).status, 400);
  assert.equal((await admin('DELETE', `/api/users/${created.body.id}`)).status, 200);

  // admin renames itself
  const renamed = await admin('PATCH', '/api/me', { current_password: 'bootstrap-pass', username: 'marco' });
  assert.equal(renamed.body.user.username, 'marco');
  assert.equal((await client()('POST', '/api/login', { username: 'marco', password: 'bootstrap-pass' })).status, 200);
});

test('CLI resets a forgotten password', async () => {
  const out = execFileSync(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'cli.js'), 'reset-password', 'marco', 'recovered-123'], { env: process.env }).toString();
  assert.match(out, /recovered-123/);
  assert.equal((await client()('POST', '/api/login', { username: 'marco', password: 'recovered-123' })).status, 200);
  assert.equal((await client()('POST', '/api/login', { username: 'marco', password: 'bootstrap-pass' })).status, 401);
});
