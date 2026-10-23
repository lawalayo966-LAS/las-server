// server/egress-guard.js
//
// SSRF guard for the hosted server. yt-dlp (and ffmpeg via -http_proxy) make
// their own outbound connections and follow HTTP redirects, so validating
// only the user's URL up front is not enough: a public page can redirect to
// http://169.254.169.254/ or a private address, or a hostname can re-resolve
// (DNS rebinding) between the check and the connection.
//
// This is a tiny forward proxy bound to 127.0.0.1. yt-dlp is started with
// --proxy pointing here, so EVERY connection it makes (first request,
// redirects, media/fragment URLs) is resolved here, checked against the
// blocked ranges, and connected to the validated IP itself (resolution is
// pinned: the address that was checked is the address that is dialled).
//
// Supports CONNECT (https) and absolute-form http requests.
'use strict';
const http = require('http');
const net = require('net');
const dns = require('dns');
const { isBlockedAddress } = require('./security');

class EgressBlocked extends Error {}

/** Resolve a hostname and return a public address, or throw EgressBlocked. */
async function resolvePublic(rawHost, { lookup = dns.promises.lookup } = {}) {
  const host = String(rawHost || '').replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) throw new EgressBlocked('no host');
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new EgressBlocked(`blocked address ${host}`);
    return { address: host, family: net.isIP(host) };
  }
  if (host === 'localhost' || /\.(localhost|local|internal)$/.test(host)) throw new EgressBlocked(`blocked host ${host}`);
  let addrs;
  try { addrs = await lookup(host, { all: true, verbatim: true }); } catch (e) { throw new EgressBlocked(`cannot resolve ${host}`); }
  if (!addrs || !addrs.length) throw new EgressBlocked(`cannot resolve ${host}`);
  // Refuse if ANY record is internal (mixed public/private answers are a rebinding trick).
  for (const a of addrs) if (isBlockedAddress(a.address)) throw new EgressBlocked(`${host} resolves to a blocked address`);
  return addrs[0];
}

/**
 * Drop-in `lookup` for http(s).request: refuses internal addresses at connect
 * time, so the validated address is the one used.
 */
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  resolvePublic(hostname).then((a) => {
    if (options && options.all) return callback(null, [{ address: a.address, family: a.family }]);
    return callback(null, a.address, a.family);
  }, (e) => callback(Object.assign(new Error(e.message), { code: 'EBLOCKED' })));
}

function parsePort(p, dflt) {
  const n = p === undefined || p === '' ? dflt : Number(p);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 0;
}

/** Start the guard on 127.0.0.1:<random>. Resolves to { url, port, close }. */
function startEgressGuard({ log = () => {} } = {}) {
  const server = http.createServer();

  // https (and any TLS) through CONNECT host:port
  server.on('connect', async (req, client, head) => {
    client.on('error', () => {});
    const target = String(req.url || '');
    const i = target.lastIndexOf(':');
    const host = i > 0 ? target.slice(0, i) : target;
    const port = parsePort(i > 0 ? target.slice(i + 1) : '', 443);
    try {
      if (!port) throw new EgressBlocked('bad port');
      const a = await resolvePublic(host);
      const up = net.connect({ host: a.address, port, family: a.family });
      up.setTimeout(120000, () => up.destroy());
      up.on('error', () => { if (!client.destroyed) { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } });
      up.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) up.write(head);
        up.pipe(client); client.pipe(up);
      });
      client.on('close', () => up.destroy());
    } catch (e) {
      log(`egress blocked: CONNECT ${target} (${e.message})`);
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    }
  });

  // plain http:// through absolute-form requests
  server.on('request', async (req, res) => {
    let u;
    try { u = new URL(req.url); } catch (_) { res.writeHead(400); return res.end(); }
    try {
      if (u.protocol !== 'http:') throw new EgressBlocked('only http in absolute form');
      const port = parsePort(u.port, 80);
      if (!port) throw new EgressBlocked('bad port');
      const a = await resolvePublic(u.hostname);
      const headers = { ...req.headers, host: u.host };
      for (const k of Object.keys(headers)) if (/^proxy-/i.test(k)) delete headers[k];
      const up = http.request({ host: a.address, family: a.family, port, method: req.method, path: u.pathname + u.search, headers, setHost: false, timeout: 120000 }, (r) => {
        res.writeHead(r.statusCode, r.headers); r.pipe(res);
      });
      up.on('timeout', () => up.destroy(new Error('timeout')));
      up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(up);
    } catch (e) {
      log(`egress blocked: ${req.method} ${u.origin} (${e.message})`);
      res.writeHead(403, { 'Content-Length': 0 }); res.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, port, close: () => new Promise((r) => server.close(r)), server });
    });
  });
}

module.exports = { startEgressGuard, resolvePublic, safeLookup, EgressBlocked };
