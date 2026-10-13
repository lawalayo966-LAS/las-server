// server/public-server.js
//
// Hosted ("public") LAS CONVERT download server for the mobile app.
// Only exposes:  GET /api/health, GET /api/media-info, GET /api/media-download
//
// Environment (all optional except LAS_API_TOKEN in production):
//   PORT                     listen port (default 8080)
//   LAS_HOST                 bind address (default 0.0.0.0)
//   LAS_API_TOKEN            required token (header X-LAS-Token or ?token=); comma-separated list allowed
//                            DEPRECATED for apps >= 2.0.0 (they send the user's Supabase JWT). Still accepted
//                            during the transition so older app versions keep working; to be removed later
//                            (the embedded token is extractable from the app binaries).
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
const WEB_DIR = (() => {
  const d = path.resolve(process.env.LAS_WEB_DIR || path.join(__dirname, '..', 'web'));
  try { return fs.statSync(path.join(d, 'index.html')).isFile() ? d : ''; } catch (_) { return ''; }
})();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.onnx': 'application/octet-stream' };

/** Static website (the LAS CONVERT web build). Returns true when it answered. */
function serveStatic(req, res, pathname) {
  if (!WEB_DIR || (req.method !== 'GET' && req.method !== 'HEAD') || pathname.startsWith('/api/')) return false;
  let rel; try { rel = decodeURIComponent(pathname); } catch (_) { return false; }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(WEB_DIR, '.' + rel);
  if (!file.startsWith(WEB_DIR + path.sep)) return false;
  let st; try { st = fs.statSync(file); } catch (_) { return false; }
  if (!st.isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  const html = ext === '.html';
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': html ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...(html ? { 'X-Frame-Options': 'SAMEORIGIN' } : {}),
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file).pipe(res);
  return true;
}
const RATE = parseInt(process.env.LAS_RATE_PER_HOUR || '30', 10);
const MAX_CONC = parseInt(process.env.LAS_MAX_MEDIA_DOWNLOADS || '2', 10);

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
ytdlp.setLogger(log);

// SaaS layer (Supabase auth / plans / R2 / Paystack); disabled unless SUPABASE_URL is set.
const saas = require('./saas').createSaas({ log });
const CORS_ORIGINS = (process.env.LAS_CORS_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
// "https://lasconverter.com" or a wildcard like "https://*.vercel.app" (one subdomain level).
function corsMatch(pattern, origin) {
  if (!origin) return false;
  if (!pattern.includes('*')) return pattern === origin;
  const esc = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${pattern.split('*').map(esc).join('[a-z0-9-]+')}$`, 'i').test(origin);
}
const hasBearer = (req) => saas.enabled && /^Bearer\s+\S/i.test(String(req.headers.authorization || ''));
function sendErr(res, e) {
  if (e && e.status) return send(res, e.status, { success: false, code: e.code, error: e.message });
  log(`error: ${e && e.stack}`);
  return send(res, 500, { success: false, code: 'internal', error: 'Internal error' });
}

function send(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

// The website served by this server (LAS_WEB_DIR) calls the API from the same
// origin without the app token; rate limits still apply. Browsers set
// Sec-Fetch-Site themselves and pages can't fake it.
function sameOriginWeb(req) {
  if (!WEB_DIR) return false;
  if (req.headers['sec-fetch-site'] === 'same-origin') return true;
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  try { return !!origin && !!host && new URL(origin).host === host; } catch (_) { return false; }
}

function tokenOk(req, urlObj) {
  if (!TOKENS.length) return true; // dev only; startup warns
  if (sameOriginWeb(req)) return true;
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
  // CORS: '*' unless LAS_CORS_ORIGINS lists the allowed sites (e.g. the Vercel frontend).
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  if (!CORS_ORIGINS.length) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (CORS_ORIGINS.some((o) => corsMatch(o, origin))) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Headers', 'X-LAS-Token, Authorization, Content-Type, Range');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (urlObj.pathname !== '/api/health' && serveStatic(req, res, urlObj.pathname)) return;
  if (urlObj.pathname === '/api/health' || urlObj.pathname === '/') return send(res, 200, { ok: true, service: 'las-public-server', jobs: true });

  if (saas.enabled) {
    const route = saas.routes[`${req.method} ${urlObj.pathname}`];
    if (route) { try { return send(res, 200, await route(req)); } catch (e) { return sendErr(res, e); } }
  }

  // Job API: polling for status and Range requests for the file keep every
  // HTTP request short, so slow mobile links and proxy timeouts don't kill a
  // long download, and an interrupted transfer resumes where it stopped.
  const jm = /^\/api\/jobs\/([a-f0-9]{24})(\/file)?$/.exec(urlObj.pathname);
  if (jm || urlObj.pathname === '/api/jobs') {
    if (!tokenOk(req, urlObj) && !hasBearer(req)) return send(res, 401, { success: false, error: 'Invalid or missing app token.' });
    if (jm) {
      let uid = null;
      try { uid = saas.enabled ? await saas.userId(req) : null; } catch (e) { return sendErr(res, e); }
      return jobRoute(req, res, jm[1], !!jm[2], uid);
    }
  }

  if (!(req.method === 'GET' && ['/api/media-info', '/api/media-download'].includes(urlObj.pathname))
    && !(req.method === 'POST' && urlObj.pathname === '/api/jobs')) return send(res, 404, { error: 'Not found' });
  if (!tokenOk(req, urlObj) && !hasBearer(req)) return send(res, 401, { success: false, error: 'Invalid or missing app token.' });

  const ip = clientIp(req);
  const wait = rateLimited(ip);
  if (wait) return send(res, 429, { success: false, code: 'rate_limited', error: `Too many requests. Try again in ${Math.ceil(wait / 60)} min.` }, { 'Retry-After': String(wait) });

  const target = (urlObj.searchParams.get('url') || '').trim();
  try { await assertPublicHttpUrl(target); } catch (e) { return send(res, 400, { success: false, error: e.message || 'Invalid URL' }); }

  let who = null;
  if (saas.enabled) { try { who = await saas.identify(req); } catch (e) { return sendErr(res, e); } }

  if (urlObj.pathname === '/api/media-info') {
    log(`info ip=${ip} url=${target}${who && who.user ? ` user=${who.user.id} plan=${who.plan.key}` : ''}`);
    try {
      const info = await ytdlp.getInfo(target, who ? { maxVideoSec: who.plan.maxVideoSec, maxAudioSec: who.plan.maxAudioSec } : {});
      if (who) {
        // Tell the UI which options need Premium (enforced again in startJob).
        info.plan = who.plan.key;
        info.options = (info.options || []).map((o) => {
          const h = /^(\d+)p$/.exec(o.tag || '');
          return { ...o, premium: (!!h && (o.short || parseInt(h[1], 10)) > who.plan.maxHeight) };
        });
        const mp3 = info.options.find((o) => o.tag === 'mp3');
        if (mp3) info.options.splice(info.options.indexOf(mp3) + 1, 0, { ...mp3, tag: 'mp3-320', quality: 'Audio only (MP3 320 kbps)', label: 'Audio only (MP3 320 kbps)', kbps: 320, bytes: mp3.bytes ? Math.round(mp3.bytes * 320 / 192) : mp3.bytes, premium: who.plan.maxBitrate < 320 });
        info.limits = { maxHeight: who.plan.maxHeight, maxBitrate: who.plan.maxBitrate, dailyDownloads: who.plan.dailyDownloads };
      }
      return send(res, 200, { success: true, ...info });
    }
    catch (e) { log(`info failed: ${e.code} ${e.message}`); return send(res, 422, { success: false, code: e.code, error: e.message }); }
  }

  const format = (urlObj.searchParams.get('format') || 'mp4').toLowerCase();
  if (!['mp4', 'mp3'].includes(format)) return send(res, 400, { success: false, error: 'format must be mp4 or mp3' });
  if (urlObj.pathname === '/api/jobs') return startJob(res, ip, target, format, urlObj, who);
  if (saas.enabled) return send(res, 410, { success: false, code: 'use_jobs', error: 'Please update the app: this download method was replaced.' });
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

// ------------------------------------------------------------------ jobs
const jobs = new Map();
const JOB_KEEP_MS = parseInt(process.env.LAS_JOB_KEEP_MIN || '45', 10) * 60e3;

function jobView(j) {
  return { success: true, id: j.id, state: j.state, percent: j.percent, speed: j.speed, eta: j.eta, status: j.status,
    downloaded: j.downloaded, total: j.total, size: j.size, name: j.name, code: j.code, error: j.error, cloudUrl: j.cloudUrl, cloudExpiresAt: j.cloudExpiresAt };
}

// Waiting jobs (SaaS mode): Premium (higher priority) first, then oldest first.
const queue = [];
const FREE_QUEUE_MAX = parseInt(process.env.LAS_FREE_QUEUE_MAX || '3', 10);
const runningCount = () => [...jobs.values()].filter((j) => j.state === 'running').length;
function pumpQueue() {
  while (queue.length && runningCount() < MAX_CONC) {
    queue.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt);
    const j = queue.shift();
    if (jobs.get(j.id) === j && j.state === 'queued') runJob(j);
  }
  queue.forEach((j, i) => { j.status = `Waiting in line (${i + 1} ahead of you)…`; });
}

async function startJob(res, ip, target, format, urlObj, who) {
  const quality = parseInt(urlObj.searchParams.get('quality') || '720', 10) || 720;
  const bitrate = parseInt(urlObj.searchParams.get('bitrate') || '192', 10) || 192;
  if (who) {
    try { saas.checkRequest(who, { format, quality, bitrate }); await saas.consume(who, ip); } catch (e) { return sendErr(res, e); }
  }
  const busy = runningCount() >= MAX_CONC;
  if (busy && (!who || (who.plan.priority <= 0 && queue.filter((q) => q.priority <= 0).length >= FREE_QUEUE_MAX))) {
    return send(res, 503, { success: false, code: 'busy', error: 'The server is busy with other downloads. Try again in a minute (Premium downloads skip the line).' }, { 'Retry-After': '60' });
  }
  const id = crypto.randomBytes(12).toString('hex');
  const ctrl = new AbortController();
  const capped = !!(who && who.plan.priority <= 0);
  const maxQ = !who ? 1080 : capped ? 4320 : who.plan.maxHeight;
  const j = { id, state: 'queued', percent: 0, speed: '', eta: '', status: 'Waiting in line…', ctrl, touched: Date.now(), queuedAt: Date.now(),
    owner: who && who.user ? who.user.id : null, who, priority: who ? who.plan.priority : 0,
    params: { capped, ip, target, format, quality: Math.min(quality, maxQ), bitrate: Math.min(bitrate, who ? who.plan.maxBitrate : 320), formatId: who && who.plan.priority <= 0 ? '' : (urlObj.searchParams.get('formatId') || '').trim(), maxDurationSec: who ? (format === 'mp3' ? who.plan.maxAudioSec : who.plan.maxVideoSec) : 0 } };
  jobs.set(id, j);
  if (busy) { queue.push(j); pumpQueue(); log(`job ${id} queued (priority ${j.priority})`); } else runJob(j);
  return send(res, 202, jobView(j));
}

function runJob(j) {
  const { id, ctrl } = j;
  const { ip, target, format, quality, bitrate, formatId, maxDurationSec } = j.params;
  j.state = 'running'; j.status = 'Downloading on the server…';
  log(`job ${id} start ip=${ip} format=${format} q=${quality}${j.owner ? ` user=${j.owner}` : ''} url=${target}`);
  ytdlp.downloadMedia(target, {
    kind: format === 'mp3' ? 'audio' : 'video',
    quality, bitrate, formatId, maxDurationSec,
    maxShortSide: j.who && j.who.plan.priority <= 0 ? j.who.plan.maxHeight : 0,
    signal: ctrl.signal,
    onProgress: (p, info = {}) => { j.percent = p; Object.assign(j, { speed: info.speed || '', eta: info.eta || '', downloaded: info.downloaded, total: info.total }); if (info.stage) j.status = info.stage; },
    onStatus: (st) => { j.status = st; },
  }).then((r) => {
    j.result = r; j.size = fs.statSync(r.file).size; j.name = safeDownloadName(`${r.title}.${r.ext}`, `media.${format}`);
    j.mime = r.ext === 'mp3' ? 'audio/mpeg' : 'video/mp4';
    if (saas.enabled && j.who && j.who.user) {
      j.status = 'Saving to your cloud history…';
      return saas.afterJob(j.who, j, { file: r.file, size: j.size, name: j.name, mime: j.mime, url: target, format, quality, fsMod: fs })
        .then((c) => { if (c) { j.cloudUrl = c.cloudUrl; j.cloudExpiresAt = c.expiresAt; } })
        .catch((e) => log(`job ${id} cloud copy failed: ${e.message}`));
    }
    return null;
  }).then(() => {
    if (j.state === 'error' || !j.result) return;
    j.state = 'done'; j.percent = 100; j.status = 'Ready'; j.doneAt = Date.now();
    log(`job ${id} done ${j.size} bytes`);
  }).catch((e) => {
    j.state = 'error'; j.code = e.code || 'ytdlp_failed'; j.error = e.message; j.doneAt = Date.now();
    if (j.params.capped && /Requested format is not available/i.test(e.message)) { j.code = 'premium_required'; j.error = 'This video has no version at your plan\'s quality (720p). HD downloads need Premium.'; }
    log(`job ${id} failed: ${e.code} ${e.message}`);
  }).finally(() => { j.who = null; pumpQueue(); });
}

function dropJob(j) {
  jobs.delete(j.id);
  const qi = queue.indexOf(j); if (qi >= 0) queue.splice(qi, 1);
  try { j.ctrl.abort(); } catch (_) {}
  if (j.result) fs.rm(j.result.dir, { recursive: true, force: true }, () => {});
}

function jobRoute(req, res, id, wantFile, uid = null) {
  const j = jobs.get(id);
  if (!j || (j.owner && j.owner !== uid)) return send(res, 404, { success: false, code: 'no_job', error: 'Download job expired or not found. Start it again.' });
  j.touched = Date.now();
  if (req.method === 'DELETE') { log(`job ${id} cancelled`); dropJob(j); return send(res, 200, { success: true }); }
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
  if (!wantFile) return send(res, 200, jobView(j));
  if (j.state !== 'done') return send(res, 409, { success: false, code: 'not_ready', error: 'Not ready yet' });
  const size = j.size;
  let start = 0; let end = size - 1; let status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = parseInt(m[1], 10); if (m[2]) end = Math.min(end, parseInt(m[2], 10)); } else { start = Math.max(0, size - parseInt(m[2], 10)); }
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    status = 206;
  }
  req.setTimeout(0); res.setTimeout(0);
  res.writeHead(status, {
    'Content-Type': j.mime, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
    'Content-Disposition': `attachment; filename="${j.name}"`, 'Cache-Control': 'no-store',
    ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === 'HEAD') return res.end();
  const st = fs.createReadStream(j.result.file, { start, end });
  st.pipe(res);
  res.on('close', () => st.destroy());
}

function sweepJobs() {
  const now = Date.now();
  for (const j of jobs.values()) {
    if (j.state !== 'running' && now - (j.doneAt || 0) > JOB_KEEP_MS && now - j.touched > 10 * 60e3) dropJob(j);
    else if ((j.state === 'running' || j.state === 'queued') && now - j.touched > 15 * 60e3) { log(`job ${j.id} abandoned`); dropJob(j); }
  }
}

function start() {
  const server = http.createServer((req, res) => handle(req, res).catch((e) => {
    log(`unexpected: ${e.stack}`);
    if (!res.headersSent) send(res, 500, { error: 'Internal error' }); else res.destroy();
  }));
  return new Promise((resolve) => server.listen(PORT, HOST, () => {
    log(`LAS public server on http://${HOST}:${server.address().port} token=${TOKENS.length ? 'required' : 'DISABLED (set LAS_API_TOKEN!)'} rate=${RATE}/h maxDur=${process.env.LAS_MAX_DURATION_SEC}s maxSize=${process.env.LAS_MAX_FILESIZE} deno=${ytdlp.denoPath()}`);
    sweepTemp(0);
    const t = setInterval(() => { sweepJobs(); sweepTemp(6 * 3600e3); }, 5 * 60e3); t.unref();
    ytdlp.resolveYtDlp().catch((e) => log(`yt-dlp init: ${e.message}`)); // warm up / update
    resolve(server);
  }));
}

if (require.main === module) start();
module.exports = { start, handle };
