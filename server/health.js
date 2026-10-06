'use strict';
// Portal reachability: is https://<domain>/login answering 200 for visitors?
//
// Two steps:
//  1. DNS, asked to public resolvers (Cloudflare, Google) like the gestionale's squadra-server.sh:
//     the name must point where the console's own domain points (= this machine). The host
//     resolver is not used for this: it may cache "no such name" from before the record existed.
//  2. HTTPS. When the console sits on the reverse proxy's Docker network (PROXY_HOST, e.g.
//     zd-proxy) it connects to the proxy directly, with the portal name as SNI and Host, and
//     verifies the certificate for that name. Going out to the machine's own public IP from
//     inside a container ("hairpin") is often blocked and would time out on a working site.

const https = require('node:https');
const dns = require('node:dns');

const resolver = new dns.promises.Resolver({ timeout: 3000, tries: 2 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);

/** Public IPv4 addresses of a name; null when the public resolvers cannot be reached. */
async function publicResolve4(name) {
  try {
    return await resolver.resolve4(name);
  } catch (e) {
    if (e.code === 'ENOTFOUND' || e.code === 'ENODATA' || e.code === 'NXDOMAIN') return [];
    return null;
  }
}

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
  EAI_AGAIN: 'DNS non raggiungibile',
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

function httpsGet(domain, { connectHost, port = 443, path = '/login', lookup = publicLookup, timeout = 10000, ca } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    const opts = {
      host: connectHost || domain,
      port,
      ca,
      servername: domain, // SNI + certificate check against the portal name, whatever we connect to
      path,
      method: 'GET',
      timeout,
      headers: { Host: domain, 'User-Agent': 'zerodark-console-health' },
    };
    if (!connectHost) opts.lookup = lookup;
    const req = https.request(opts, (res) => {
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

/**
 * Resolves to { code, error }: code is the HTTP status (0 when there was no answer), error a short reason.
 * opts.referenceHost: a name known to point to this machine (the console's own domain).
 * opts.connectHost:   reverse proxy reachable on the internal network (e.g. "zd-proxy").
 */
async function probe(domain, opts = {}) {
  const resolve4 = opts.resolve4 || publicResolve4;
  if (opts.referenceHost) {
    const [mine, here] = await Promise.all([resolve4(domain), resolve4(opts.referenceHost)]);
    if (mine && here) {
      if (!mine.length) return { code: 0, error: 'nome non trovato nel DNS' };
      if (here.length && !mine.some((ip) => here.includes(ip))) {
        return { code: 0, error: `il DNS punta a ${mine.join(', ')}, non a questo server (${here.join(', ')})` };
      }
    }
    // public resolvers unreachable: skip the DNS step, the HTTPS step still says something useful
  }
  return httpsGet(domain, opts);
}

module.exports = { probe, publicLookup, publicResolve4 };
