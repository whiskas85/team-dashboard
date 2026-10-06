'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { probe } = require('../server/health');

// Resolve every name to localhost, as if DNS pointed to this machine.
const local = (host, opts, cb) => {
  if (typeof opts === 'function') [cb, opts] = [opts, {}];
  if (opts.all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
  else cb(null, '127.0.0.1', 4);
};

test('probe: 200, other status, TLS without certificate, DNS failure', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zdt-tls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=demo.zerodarkteam.it',
    '-addext', 'subjectAltName=DNS:demo.zerodarkteam.it', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  const cert = fs.readFileSync(path.join(dir, 'c.pem'));
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert }, (req, res) => {
    res.statusCode = req.url === '/login' ? 200 : req.url === '/protetto' ? 401 : 404;
    res.end('ok');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const port = srv.address().port;

  assert.deepEqual(await probe('demo.zerodarkteam.it', { lookup: local, port, ca: cert }), { code: 200, error: null });
  assert.deepEqual(await probe('demo.zerodarkteam.it', { lookup: local, port, ca: cert, path: '/protetto' }), { code: 401, error: null }, '401 = up behind a password');
  const other = await probe('demo.zerodarkteam.it', { lookup: local, port, ca: cert, path: '/nope' });
  assert.equal(other.code, 404);

  // A proxy that has no certificate for the name (what Caddy does before the site exists)
  const plain = http.createServer((req, res) => res.end());
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
  t.after(() => plain.close());
  const tls = await probe('demo.zerodarkteam.it', { lookup: local, port: plain.address().port, timeout: 3000 });
  assert.equal(tls.code, 0);
  assert.match(tls.error, /TLS|certificato/);

  // Through the proxy on the internal network: certificate checked against the portal name.
  assert.deepEqual(await probe('demo.zerodarkteam.it', { connectHost: '127.0.0.1', port, ca: cert }), { code: 200, error: null });
  const wrongName = await probe('altro.zerodarkteam.it', { connectHost: '127.0.0.1', port, ca: cert });
  assert.equal(wrongName.code, 0);
  assert.match(wrongName.error, /altro nome|certificat/);

  // DNS step: compared with the console's own domain (this machine)
  const dnsTable = { 'console.zerodarkteam.it': ['209.227.239.117'], 'demo.zerodarkteam.it': ['209.227.239.117'], 'nuovo.zerodarkteam.it': [], 'altrove.zerodarkteam.it': ['1.2.3.4'] };
  const resolve4 = async (n) => dnsTable[n] ?? [];
  const viaProxy = { connectHost: '127.0.0.1', port, ca: cert, referenceHost: 'console.zerodarkteam.it', resolve4 };
  assert.deepEqual(await probe('demo.zerodarkteam.it', viaProxy), { code: 200, error: null });
  assert.deepEqual(await probe('nuovo.zerodarkteam.it', viaProxy), { code: 0, error: 'nome non trovato nel DNS' });
  assert.match((await probe('altrove.zerodarkteam.it', viaProxy)).error, /punta a 1\.2\.3\.4, non a questo server/);
  // public resolvers unreachable: DNS step skipped, HTTPS still checked
  assert.deepEqual(await probe('demo.zerodarkteam.it', { ...viaProxy, resolve4: async () => null }), { code: 200, error: null });

  const nodns = await probe('demo.zerodarkteam.it', { lookup: (h, o, cb) => (typeof o === 'function' ? o : cb)(Object.assign(new Error('x'), { code: 'ENOTFOUND' })) });
  assert.deepEqual(nodns, { code: 0, error: 'nome non trovato nel DNS' });
});
