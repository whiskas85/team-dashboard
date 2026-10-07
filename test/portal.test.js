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

  // Existing portals found by the agent (e.g. production) can be marked as portals with their domain...
  await call('POST', '/api/agent/report', { samples: [{ system: { cpu_pct: 1 }, apps: [{ name: 'gestionale', kind: 'docker', match: '^zd-(app|db)$', cpu_pct: 1, mem_mb: 100 }] }] }, { authorization: `Bearer ${srv.token}` });
  let apps = (await call('GET', `/api/servers/${srv.id}`)).body.apps;
  const prod = apps.find((a) => a.name === 'gestionale');
  assert.equal(prod.type, 'service');
  assert.equal(prod.provisioned, 0);
  assert.equal((await call('PATCH', `/api/apps/${prod.id}`, { type: 'portal', domain: null })).status, 400, 'a portal needs a domain');
  assert.equal((await call('PATCH', `/api/apps/${prod.id}`, { match: '([' })).status, 400, 'invalid regex');
  const edited = await call('PATCH', `/api/apps/${prod.id}`, { type: 'portal', domain: 'OPS.zerodarkteam.it' });
  assert.equal(edited.status, 200);
  assert.deepEqual([edited.body.type, edited.body.domain, edited.body.match], ['portal', 'ops.zerodarkteam.it', '^zd-(app|db)$']);

  // ...but the console never runs remove_app on something it did not create
  const del = await call('DELETE', `/api/apps/${prod.id}?deprovision=1`);
  assert.equal(del.status, 400);
  assert.match(del.body.error, /non è stata creata dalla console/);
  apps = (await call('GET', `/api/servers/${srv.id}`)).body.apps;
  assert.equal(apps.find((a) => a.name === 'gestionale').status, 'active');
  const demo = apps.find((a) => a.name === 'demo');
  assert.equal(demo.provisioned, 1);
  assert.equal((await call('DELETE', `/api/apps/${prod.id}`)).body.status, 'unmonitored', 'monitoring can always be stopped');
  // ...and undone: it waits in the Archive, the agent's samples are not stored meanwhile
  const auth0 = { authorization: `Bearer ${srv.token}` };
  const before = db.prepare('SELECT COUNT(*) n FROM app_metrics WHERE app_id = ?').get(prod.id).n;
  await call('POST', '/api/agent/report', { samples: [{ system: { cpu_pct: 1 }, apps: [{ name: 'gestionale', kind: 'docker', cpu_pct: 1, mem_mb: 100 }] }] }, auth0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM app_metrics WHERE app_id = ?').get(prod.id).n, before, 'not monitored, not recreated');
  assert.ok((await call('GET', '/api/apps?view=archive')).body.some((a) => a.name === 'gestionale' && a.status === 'unmonitored'));
  assert.match((await call('POST', `/api/servers/${srv.id}/apps`, { type: 'service', name: 'gestionale', provision: false })).body.error, /ricollegala/);
  assert.equal((await call('POST', `/api/apps/${prod.id}/reattach`)).body.status, 'active');
  const back = (await call('GET', `/api/servers/${srv.id}`)).body.apps.find((a) => a.name === 'gestionale');
  assert.deepEqual([back.status, back.type, back.domain], ['active', 'portal', 'ops.zerodarkteam.it'], 'settings kept');
  await call('DELETE', `/api/apps/${prod.id}`);
  assert.equal((await call('POST', `/api/apps/${prod.id}/purge`, { confirm: 'gestionale' })).body.status, 'deleted', 'removed from the console only');
  assert.equal((await call('DELETE', `/api/apps/${demo.id}?deprovision=1`)).status, 400, 'the name must be typed to confirm');
  assert.equal((await call('DELETE', `/api/apps/${demo.id}?deprovision=1&confirm=demo`)).body.status, 'removing');

  // remove_app done -> the portal goes to the Archive (not deleted), with its archive folder
  const auth = { authorization: `Bearer ${srv.token}` };
  let tasks = (await call('POST', '/api/agent/report', { samples: [] }, auth)).body.tasks;
  const removeTask = tasks.find((t) => t.action === 'remove_app');
  assert.equal(removeTask.payload.name, 'demo');
  await call('POST', `/api/agent/tasks/${removeTask.id}`, { status: 'done', message: '== backup fatto\n== cartella spostata in /opt/archivio/squadra-demo-20261006120000 (chiavi e accesso restano li\')' }, auth);
  const running = (await call('GET', '/api/apps?view=all')).body.map((a) => a.name);
  assert.ok(!running.includes('demo'), 'archived portals leave the running lists');
  assert.ok(!(await call('GET', `/api/servers/${srv.id}`)).body.apps.some((a) => a.name === 'demo'));
  const archive = (await call('GET', '/api/apps?view=archive')).body;
  assert.equal(archive.length, 1);
  assert.deepEqual([archive[0].name, archive[0].status, archive[0].archive_path, archive[0].archived_by, archive[0].server_name],
    ['demo', 'archived', '/opt/archivio/squadra-demo-20261006120000', 'admin', 'zerodarkserver']);
  assert.match((await create({ name: 'demo' })).body.error, /archivio/, 'name stays taken while archived');
  assert.ok(!(await call('POST', '/api/agent/report', { samples: [] }, auth)).body.apps.some((a) => a.name === 'demo'), 'no longer monitored');

  // purge: only from the archive, name confirmed, then purge_app; on success it is gone
  const portals = (await call('GET', '/api/apps?view=portals')).body;
  assert.equal((await call('POST', `/api/apps/${portals[0].id}/purge`, { confirm: portals[0].name })).status, 400, 'only archived apps');
  assert.equal((await call('POST', `/api/apps/${archive[0].id}/purge`, { confirm: 'nope' })).status, 400);
  assert.equal((await call('POST', `/api/apps/${archive[0].id}/purge`, { confirm: 'demo' })).body.status, 'purging');
  tasks = (await call('POST', '/api/agent/report', { samples: [] }, auth)).body.tasks;
  const purgeTask = tasks.find((t) => t.action === 'purge_app');
  assert.deepEqual([purgeTask.payload.name, purgeTask.payload.archive_path], ['demo', '/opt/archivio/squadra-demo-20261006120000']);
  await call('POST', `/api/agent/tasks/${purgeTask.id}`, { status: 'failed', message: 'Hook non installato' }, auth);
  assert.equal((await call('GET', '/api/apps?view=archive')).body[0].status, 'archived', 'a failed purge leaves it in the archive');
  await call('POST', `/api/apps/${archive[0].id}/purge`, { confirm: 'demo' });
  const retry = (await call('POST', '/api/agent/report', { samples: [] }, auth)).body.tasks.find((t) => t.action === 'purge_app');
  await call('POST', `/api/agent/tasks/${retry.id}`, { status: 'done', message: 'volumi e cartella eliminati' }, auth);
  assert.equal((await call('GET', '/api/apps?view=archive')).body.length, 0);
  assert.equal((await create({ name: 'demo', email: 'a@b.it' })).status, 200, 'name free again');

  // A squad registered by hand as a plain service, then edited into a portal, becomes archivable;
  // production-like portals (zd-app, reserved names) never do.
  await call('POST', `/api/servers/${srv.id}/apps`, { type: 'service', name: 'verdi', kind: 'docker', match: '^zd-sq-verdi-', provision: false });
  await call('POST', `/api/servers/${srv.id}/apps`, { type: 'service', name: 'test9', kind: 'docker', match: '^zd-sq-test9-', provision: false });
  let list = (await call('GET', `/api/servers/${srv.id}`)).body.apps;
  const verdi = list.find((a) => a.name === 'verdi');
  const test9 = list.find((a) => a.name === 'test9');
  assert.equal(verdi.provisioned, 0);
  await call('PATCH', `/api/apps/${verdi.id}`, { type: 'portal', domain: 'verdi.zerodarkteam.it' });
  await call('PATCH', `/api/apps/${test9.id}`, { type: 'portal', domain: 'test9.zerodarkteam.it' });
  list = (await call('GET', `/api/servers/${srv.id}`)).body.apps;
  assert.equal(list.find((a) => a.name === 'verdi').provisioned, 1, 'zd-sq squad can be archived');
  assert.equal(list.find((a) => a.name === 'test9').provisioned, 0, 'reserved names never');

  // New first-access password for a squad portal whose password the console does not know
  assert.equal((await call('POST', `/api/apps/${test9.id}/credentials/reset`)).status, 400, 'only squad portals');
  await call('POST', '/api/agent/report', { agent_version: '0.1.2', samples: [] }, auth);
  assert.match((await call('POST', `/api/apps/${verdi.id}/credentials/reset`)).body.error, /Installa agent/, 'old agents drop the password');
  await call('POST', '/api/agent/report', { agent_version: '0.1.3', samples: [] }, auth);
  assert.equal((await call('POST', `/api/apps/${verdi.id}/credentials/reset`)).body.status, 'resetting');
  assert.equal((await call('POST', `/api/apps/${verdi.id}/credentials/reset`)).status, 409, 'one at a time');
  const nextReset = async () => (await call('POST', '/api/agent/report', { samples: [] }, auth)).body.tasks.find((t) => t.action === 'set_admin_password');
  let reset = await nextReset();
  assert.equal(reset.payload.name, 'verdi');
  assert.match(reset.payload.admin_password, /^[A-Za-z2-9]{16}$/);
  assert.ok(!db.prepare('SELECT payload FROM tasks WHERE id = ?').get(reset.id).payload.includes(reset.payload.admin_password), 'never stored in the task');
  await call('POST', `/api/agent/tasks/${reset.id}`, { status: 'failed', message: 'Hook non installato' }, auth);
  let v = (await call('GET', `/api/servers/${srv.id}`)).body.apps.find((a) => a.name === 'verdi');
  assert.deepEqual([v.credentials.status, v.credentials.error], ['failed', 'Hook non installato']);
  assert.equal((await call('GET', `/api/apps/${verdi.id}/credentials`)).body.password, undefined, 'not shown unless applied');
  await call('POST', `/api/apps/${verdi.id}/credentials/reset`);
  reset = await nextReset();
  await call('POST', `/api/agent/tasks/${reset.id}`, { status: 'done', message: 'password aggiornata', app: { admin_password: 'applied' } }, auth);
  const shown = (await call('GET', `/api/apps/${verdi.id}/credentials`)).body;
  assert.deepEqual([shown.status, shown.password, shown.login_url], ['applied', reset.payload.admin_password, 'https://verdi.zerodarkteam.it/login']);
});

test('our own gestionale becomes the hosted squad "zerodark" (3.29.0)', async () => {
  const { adoptOwnSquad } = require('../server/db');
  const srv = (await call('POST', '/api/servers', { name: 'prod-host' })).body;
  const auth = { authorization: `Bearer ${srv.token}` };
  // the old production app, declared in the agent's local config
  await call('POST', '/api/agent/report', { samples: [{ system: { cpu_pct: 1 }, apps: [{ name: 'gestionale', kind: 'docker', match: '^zd-(app|db)$', cpu_pct: 1, mem_mb: 100 }] }] }, auth);
  const old = (await call('GET', `/api/servers/${srv.id}`)).body.apps.find((a) => a.name === 'gestionale');
  await call('PATCH', `/api/apps/${old.id}`, { type: 'portal', domain: 'ops.zerodarkteam.it' });

  assert.equal(adoptOwnSquad(db), 1);
  assert.equal(adoptOwnSquad(db), 0, 'idempotent');
  const apps = (await call('GET', `/api/servers/${srv.id}`)).body.apps;
  const own = apps.find((a) => a.name === 'zerodark');
  assert.deepEqual([own.type, own.kind, own.match, own.domain, own.provisioned, own.own], ['portal', 'docker', '^zd-sq-zerodark-', 'ops.zerodarkteam.it', 1, true]);
  assert.ok(!apps.some((a) => a.name === 'gestionale'), 'old app no longer monitored');
  assert.ok((await call('GET', '/api/apps?view=archive')).body.some((a) => a.name === 'gestionale' && a.status === 'unmonitored'));
  assert.equal(apps.find((a) => a.name === 'postgres-squadre').match, '^zd-sq-pg$', 'shared Postgres monitored');
  // agent tells the console what to watch
  const watched = (await call('POST', '/api/agent/report', { samples: [] }, auth)).body.apps.map((a) => a.match);
  assert.ok(watched.includes('^zd-sq-zerodark-') && watched.includes('^zd-sq-pg$'));

  // never archived from the console; a new portal cannot take the name
  const del = await call('DELETE', `/api/apps/${own.id}?deprovision=1&confirm=zerodark`);
  assert.equal(del.status, 400);
  assert.match(del.body.error, /produzione/);
  assert.match((await call('POST', `/api/servers/${srv.id}/apps`, { type: 'portal', name: 'zerodark' })).body.error, /riservato/);
  // updates and password reset work as for any squad
  assert.equal((await call('GET', `/api/apps/${own.id}/updates`)).body.name, 'zerodark');
});
