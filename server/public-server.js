// server/public-server.js
//
// Hosted ("public") LAS CONVERT download server for the mobile app.
// Only exposes:  GET /api/health, GET /api/media-info, GET /api/media-download
//
// Environment (all optional except LAS_API_TOKEN in production):
//   PORT                     listen port (default 8080)
//   LAS_HOST                 bind address (default 0.0.0.0)
//   LAS_API_TOKEN            required token (header X-LAS-Token or ?token=); comma-separated list allowed
//   LAS_RATE_PER_HOUR        media requests per client IP per hour (default 30)
//   LAS_MAX_MEDIA_DOWNLOADS  concurrent downloads (default 2)
//   LAS_MAX_DURATION_SEC     reject longer videos (default 1800 = 30 min)
//   LAS_MAX_FILESIZE         yt-dlp --max-filesize (default 300M)
//   LAS_TRUST_PROXY          "1" to take the client IP from X-Forwarded-For (PaaS load balancers)
//   SERVER_COOKIES / LAS_SERVER_COOKIES_FILE  cookies.txt for YouTube bot checks
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.LAS_MAX_DURATION_SEC = process.env.LAS_MAX_DURATION_SEC || '1800';
process.env.LAS_MAX_FILESIZE = process.env.LAS_MAX_FILESIZE || '300M';
process.env.LAS_NO_BROWSER_COOKIES = '1';

const ytdlp = require('./ytdlp');
const { assertPublicHttpUrl, safeDownloadName } = require('./security');

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.LAS_HOST || '0.0.0.0';
const TOKENS = (process.env.LAS_API_TOKEN || '').split(',').map((t) => t.trim()).filter(Boolean);
const RATE = parseInt(process.env.LAS_RATE_PER_HOUR || '30', 10);
const MAX_CONC = parseInt(process.env.LAS_MAX_MEDIA_DOWNLOADS || '2', 10);

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
ytdlp.setLogger(log);

function send(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

function tokenOk(req, urlObj) {
  if (!TOKENS.length) return true; // dev only; startup warns
  const t = req.headers['x-las-token'] || urlObj.searchParams.get('token') || '';
  const tb = Buffer.from(String(t));
  return TOKENS.some((k) => { const kb = Buffer.from(k); return kb.length === tb.length && crypto.timingSafeEqual(kb, tb); });
}

function clientIp(req) {
  if (process.env.LAS_TRUST_PROXY === '1' && req.headers['x-forwarded-for']) {
    return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// Sliding-window rate limit per IP.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (arr.length >= RATE) { hits.set(ip, arr); return Math.ceil((arr[0] + 3600e3 - now) / 1000); }
  arr.push(now); hits.set(ip, arr);
  return 0;
}

// Remove stale temp downloads (crashes / aborted requests).
function sweepTemp(maxAgeMs = 3600e3) {
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith('las-ytdl-')) continue;
      const p = path.join(os.tmpdir(), name);
      try { if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
    }
    for (const [ip, arr] of hits) if (!arr.some((t) => Date.now() - t < 3600e3)) hits.delete(ip);
  } catch (_) {}
}

let active = 0;
async function handle(req, res) {
  const urlObj = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'X-LAS-Token, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (urlObj.pathname === '/api/health' || urlObj.pathname === '/') return send(res, 200, { ok: true, service: 'las-public-server' });
  if (req.method !== 'GET' || !['/api/media-info', '/api/media-download'].includes(urlObj.pathname)) return send(res, 404, { error: 'Not found' });
  if (!tokenOk(req, urlObj)) return send(res, 401, { success: false, error: 'Invalid or missing app token.' });

  const ip = clientIp(req);
  const wait = rateLimited(ip);
  if (wait) return send(res, 429, { success: false, code: 'rate_limited', error: `Too many requests. Try again in ${Math.ceil(wait / 60)} min.` }, { 'Retry-After': String(wait) });

  const target = (urlObj.searchParams.get('url') || '').trim();
  try { await assertPublicHttpUrl(target); } catch (e) { return send(res, 400, { success: false, error: e.message || 'Invalid URL' }); }

  if (urlObj.pathname === '/api/media-info') {
    log(`info ip=${ip} url=${target}`);
    try { return send(res, 200, { success: true, ...(await ytdlp.getInfo(target)) }); }
    catch (e) { log(`info failed: ${e.code} ${e.message}`); return send(res, 422, { success: false, code: e.code, error: e.message }); }
  }

  const format = (urlObj.searchParams.get('format') || 'mp4').toLowerCase();
  if (!['mp4', 'mp3'].includes(format)) return send(res, 400, { success: false, error: 'format must be mp4 or mp3' });
  if (active >= MAX_CONC) return send(res, 503, { success: false, code: 'busy', error: 'Server is busy, try again in a minute.' }, { 'Retry-After': '60' });
  active++;
  req.setTimeout(0); res.setTimeout(0);
  log(`download ip=${ip} format=${format} url=${target}`);
  let result;
  try {
    result = await ytdlp.downloadMedia(target, {
      kind: format === 'mp3' ? 'audio' : 'video',
      quality: Math.min(parseInt(urlObj.searchParams.get('quality') || '720', 10) || 720, 1080),
      formatId: (urlObj.searchParams.get('formatId') || '').trim(),
    });
  } catch (e) {
    active--;
    log(`download failed: ${e.code} ${e.message}`);
    return send(res, 422, { success: false, code: e.code, error: e.message });
  }
  active--;
  const cleanup = () => fs.rm(result.dir, { recursive: true, force: true }, () => {});
  const name = safeDownloadName(`${result.title}.${result.ext}`, `media.${format}`);
  res.writeHead(200, {
    'Content-Type': result.ext === 'mp3' ? 'audio/mpeg' : 'video/mp4',
    'Content-Length': fs.statSync(result.file).size,
    'Content-Disposition': `attachment; filename="${name}"`,
  });
  const st = fs.createReadStream(result.file);
  st.pipe(res);
  st.on('close', cleanup);
  res.on('close', () => { st.destroy(); cleanup(); });
}

function start() {
  const server = http.createServer((req, res) => handle(req, res).catch((e) => {
    log(`unexpected: ${e.stack}`);
    if (!res.headersSent) send(res, 500, { error: 'Internal error' }); else res.destroy();
  }));
  return new Promise((resolve) => server.listen(PORT, HOST, () => {
    log(`LAS public server on http://${HOST}:${server.address().port} token=${TOKENS.length ? 'required' : 'DISABLED (set LAS_API_TOKEN!)'} rate=${RATE}/h maxDur=${process.env.LAS_MAX_DURATION_SEC}s maxSize=${process.env.LAS_MAX_FILESIZE} deno=${ytdlp.denoPath()}`);
    sweepTemp(0);
    const t = setInterval(sweepTemp, 10 * 60e3); t.unref();
    ytdlp.resolveYtDlp().catch((e) => log(`yt-dlp init: ${e.message}`)); // warm up / update
    resolve(server);
  }));
}

if (require.main === module) start();
module.exports = { start };
