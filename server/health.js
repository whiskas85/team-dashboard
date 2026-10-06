'use strict';
// Portal reachability probe: GET https://<domain>/login must answer 200.
//
// Names are resolved through public resolvers (Cloudflare, Google), like the gestionale's
// squadra-server.sh does: the host resolver may still cache "this name does not exist" from
// before the DNS record was created, which would keep a working portal marked as down.

const https = require('node:https');
const dns = require('node:dns');

const resolver = new dns.promises.Resolver({ timeout: 3000, tries: 2 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);

// dns.lookup-compatible function for https.request: public resolvers first, system as fallback.
function publicLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  resolver
    .resolve4(hostname)
    .then((addrs) => {
      if (!addrs.length) throw new Error('no A record');
      if (options.all) callback(null, addrs.map((address) => ({ address, family: 4 })));
      else callback(null, addrs[0], 4);
    })
    .catch(() => dns.lookup(hostname, options, callback));
}

const REASONS = {
  ENOTFOUND: 'nome non trovato nel DNS',
  ENODATA: 'nessun record DNS',
  ECONNREFUSED: 'connessione rifiutata',
  ECONNRESET: 'connessione interrotta',
  ETIMEDOUT: 'tempo scaduto',
  ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR: 'il proxy non ha ancora un certificato per questo nome',
  EPROTO: 'errore TLS: il proxy non ha ancora un certificato per questo nome',
  CERT_HAS_EXPIRED: 'certificato scaduto',
  ERR_TLS_CERT_ALTNAME_INVALID: 'certificato per un altro nome',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'certificato non valido (autofirmato)',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificato non verificabile',
};

/** Resolves to { code, error }: code is the HTTP status (0 when no response), error a short reason. */
function probe(domain, { timeout = 10000, path = '/login', lookup = publicLookup, port = 443, ca } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    const req = https.request({ host: domain, port, ca, servername: domain, path, method: 'GET', lookup, timeout, headers: { 'User-Agent': 'zerodark-console-health' } }, (res) => {
      res.resume();
      finish({ code: res.statusCode, error: res.statusCode === 200 ? null : `${path} risponde ${res.statusCode}` });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => {
      const reason = REASONS[e.code] || (/alert|ssl|tls/i.test(e.message) ? 'errore TLS: certificato non ancora pronto?' : e.code || e.message);
      finish({ code: 0, error: reason });
    });
    req.end();
  });
}

module.exports = { probe, publicLookup };
