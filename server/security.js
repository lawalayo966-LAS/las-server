// server/security.js
//
// Shared security helpers for the local LAS CONVERT servers:
//   - path containment (prevents path traversal / zip-slip)
//   - localhost-only bind address, Host header and CORS origin checks
//   - SSRF guard (blocks private, loopback, link-local, ... addresses)

const path = require('path');
const net = require('net');
const dns = require('dns');

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

/**
 * Resolve `untrusted` relative to `baseDir` and return the absolute path only
 * if it stays strictly inside `baseDir`. Returns null otherwise.
 * Rejects absolute paths, Windows drive letters / UNC paths, NUL bytes and
 * any `..` traversal that escapes the base directory.
 */
function resolveInside(baseDir, untrusted) {
  if (typeof untrusted !== 'string' || untrusted.length === 0) return null;
  if (untrusted.includes('\0')) return null;
  // Normalise Windows separators so "..\\..\\x" is treated as traversal on every OS.
  const candidate = untrusted.replace(/\\/g, '/');
  if (candidate.startsWith('/') || /^[a-zA-Z]:/.test(candidate) || candidate.startsWith('//')) return null;

  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, candidate);
  const rel = path.relative(base, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

/** True if `target` (absolute) is inside `baseDir`. */
function isInside(baseDir, target) {
  const rel = path.relative(path.resolve(baseDir), path.resolve(target));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidJobId(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}

/** Make a string safe for use inside a Content-Disposition filename="..." */
function safeDownloadName(name, fallback = 'download.bin') {
  const cleaned = String(name || '')
    .replace(/[\\/]/g, '_')
    .replace(/[^a-zA-Z0-9._ ()-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 180)
    .trim();
  return cleaned || fallback;
}

// ---------------------------------------------------------------------------
// Bind address / Host / Origin checks
// ---------------------------------------------------------------------------

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Address the servers bind to. Defaults to loopback; override with LAS_HOST. */
function getBindHost() {
  return process.env.LAS_HOST || '127.0.0.1';
}

function extraAllowedOrigins() {
  return (process.env.LAS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Origins allowed to call the APIs: http(s)://localhost|127.0.0.1|[::1](:port) plus LAS_ALLOWED_ORIGINS. */
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (extraAllowedOrigins().includes(origin)) return true;
  let u;
  try {
    u = new URL(origin);
  } catch (e) {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return LOCAL_HOSTNAMES.has(u.hostname) || configuredHosts().has(u.hostname);
}

/** Extra hostnames explicitly configured via LAS_HOST / LAS_ALLOWED_HOSTS (never wildcards). */
function configuredHosts() {
  return new Set(
    [process.env.LAS_HOST, ...(process.env.LAS_ALLOWED_HOSTS || '').split(',')]
      .map((s) => (s || '').trim())
      .filter((s) => s && s !== '0.0.0.0' && s !== '::')
  );
}

/**
 * Protects against DNS-rebinding: the Host header must be a loopback name
 * (or the explicitly configured LAS_HOST / LAS_ALLOWED_HOSTS).
 */
function isAllowedHostHeader(hostHeader) {
  if (!hostHeader) return false;
  let hostname;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch (e) {
    return false;
  }
  return LOCAL_HOSTNAMES.has(hostname) || configuredHosts().has(hostname);
}

/**
 * Apply CORS headers for allowed origins and reject cross-site requests.
 * Returns true if the request may proceed, false if a response was already sent.
 */
function applyCors(req, res, { methods = 'GET, POST, PUT, OPTIONS' } = {}) {
  if (!isAllowedHostHeader(req.headers.host)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden host');
    return false;
  }

  const origin = req.headers.origin;
  if (origin) {
    if (!isAllowedOrigin(origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden origin');
      return false;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, oct) => ((acc << 8) + parseInt(oct, 10)) >>> 0, 0);
}

const BLOCKED_V4 = [
  ['0.0.0.0', 8],        // "this" network / unspecified
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // carrier-grade NAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local (incl. cloud metadata 169.254.169.254)
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.88.99.0', 24],   // 6to4 relay
  ['192.168.0.0', 16],   // private
  // 198.18.0.0/15 (benchmarking) is intentionally NOT blocked: "fake-IP" DNS
  // modes of common proxy/VPN clients map every public domain into it.
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved + broadcast
].map(([base, bits]) => [ipv4ToInt(base), bits]);

function isBlockedIPv4(ip) {
  const n = ipv4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

function expandIPv6(ip) {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);
  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4)
  const v4Match = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Match) {
    const n = ipv4ToInt(v4Match[1]);
    addr = addr.replace(v4Match[1], `${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`);
  }
  const [head, tail] = addr.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = addr.includes('::') ? 8 - headParts.length - tailParts.length : 0;
  const parts = [...headParts, ...Array(Math.max(0, fill)).fill('0'), ...tailParts];
  return parts.map((p) => parseInt(p || '0', 16));
}

function isBlockedIPv6(ip) {
  const p = expandIPv6(ip);
  if (p.length !== 8 || p.some((x) => Number.isNaN(x))) return true;
  const allZeroPrefix = p.slice(0, 5).every((x) => x === 0);
  // :: and ::1
  if (p.slice(0, 7).every((x) => x === 0) && (p[7] === 0 || p[7] === 1)) return true;
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d -> check the IPv4 part
  if (allZeroPrefix && (p[5] === 0xffff || p[5] === 0)) {
    const v4 = `${p[6] >> 8}.${p[6] & 0xff}.${p[7] >> 8}.${p[7] & 0xff}`;
    return isBlockedIPv4(v4);
  }
  // NAT64 64:ff9b::/96 -> check embedded IPv4
  if (p[0] === 0x64 && p[1] === 0xff9b && p.slice(2, 6).every((x) => x === 0)) {
    const v4 = `${p[6] >> 8}.${p[6] & 0xff}.${p[7] >> 8}.${p[7] & 0xff}`;
    return isBlockedIPv4(v4);
  }
  if ((p[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((p[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((p[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((p[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (p[0] === 0x2001 && p[1] === 0x0db8) return true; // documentation
  if (p[0] === 0x2002) return true; // 6to4 (can embed private IPv4)
  if (p[0] === 0x2001 && p[1] === 0x0000) return true; // Teredo
  return false;
}

/** True if the literal IP address must not be contacted by the proxy. */
function isBlockedAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return true; // not an IP literal -> refuse
}

class SsrfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SsrfError';
  }
}

/**
 * Parse and validate an outbound URL. Only http/https, no credentials.
 * Resolves DNS and rejects the URL if ANY resolved address is non-public.
 * Returns { url, address, family } so the caller can pin the connection to
 * the validated address (prevents DNS rebinding between check and use).
 */
async function assertPublicHttpUrl(rawUrl, { lookup = dns.promises.lookup } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch (e) {
    throw new SsrfError('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('Only http and https URLs are allowed');
  }
  if (url.username || url.password) {
    throw new SsrfError('URLs with embedded credentials are not allowed');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) throw new SsrfError('URL has no host');

  let addresses;
  if (net.isIP(hostname)) {
    addresses = [{ address: hostname, family: net.isIP(hostname) }];
  } else {
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      throw new SsrfError('Local hostnames are not allowed');
    }
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch (e) {
      throw new SsrfError(`Could not resolve host ${hostname}`);
    }
  }
  if (!addresses || addresses.length === 0) throw new SsrfError(`Could not resolve host ${hostname}`);
  for (const a of addresses) {
    if (isBlockedAddress(a.address)) {
      throw new SsrfError('Destination address is not allowed (private, loopback, link-local or reserved)');
    }
  }
  return { url, address: addresses[0].address, family: addresses[0].family };
}

module.exports = {
  resolveInside,
  isInside,
  isValidJobId,
  safeDownloadName,
  getBindHost,
  isAllowedOrigin,
  isAllowedHostHeader,
  applyCors,
  isBlockedAddress,
  assertPublicHttpUrl,
  SsrfError,
};
