// server/ytdlp.js
//
// Locate (and keep fresh) a standalone yt-dlp executable, then use it to
// download a page URL (YouTube, TikTok, ...) as MP4 video or MP3 audio.
//
// Resolution order:
//   1. LAS_YTDLP env var (explicit path)
//   2. writable cache copy  <LAS_YTDLP_DIR or ~/.las-convert>/bin/yt-dlp[.exe]
//   3. binary bundled with the packaged app (<resources>/bin) -> copied to cache
//   4. auto-download of the official release from github.com/yt-dlp/yt-dlp
//   5. `yt-dlp` on PATH, then `python -m yt_dlp`
// The cached binary self-updates (`yt-dlp -U`) at most once a day because
// YouTube changes frequently break older yt-dlp versions.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { FFMPEG_PATH } = require('./binaries');

const IS_WIN = process.platform === 'win32';
const EXE_NAME = IS_WIN ? 'yt-dlp.exe' : 'yt-dlp';
const RELEASE_ASSET = IS_WIN ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos'
  : process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
const RELEASE_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${RELEASE_ASSET}`;
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function cacheDir() {
  return path.join(process.env.LAS_YTDLP_DIR || path.join(os.homedir(), '.las-convert'), 'bin');
}
function cachedBinary() { return path.join(cacheDir(), EXE_NAME); }

function bundledBinary() {
  const dirs = [];
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'bin'));
  dirs.push(path.join(__dirname, '..', 'resources', 'bin'));
  for (const d of dirs) {
    const p = path.join(d, EXE_NAME);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function httpsDownload(url, dest, redirects = 6) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'LAS-CONVERT' }, timeout: 60000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return httpsDownload(new URL(res.headers.location, url).toString(), dest, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} downloading yt-dlp`)); }
      const tmp = `${dest}.${crypto.randomUUID()}.part`;
      const out = fs.createWriteStream(tmp, { mode: 0o755 });
      res.pipe(out);
      out.on('finish', () => out.close(() => { fs.renameSync(tmp, dest); resolve(dest); }));
      out.on('error', (e) => { fs.rm(tmp, { force: true }, () => {}); reject(e); });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('yt-dlp download timed out')); });
  });
}

function onPath(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const exts = IS_WIN ? ['.exe', '.cmd', ''] : [''];
  for (const d of dirs) for (const e of exts) {
    const p = path.join(d, cmd + e);
    try { if (fs.statSync(p).isFile()) return p; } catch (_) {}
  }
  return null;
}

function headLocation(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD', headers: { 'User-Agent': 'LAS-CONVERT' }, timeout: 15000 }, (res) => {
      res.resume(); resolve(res.headers.location || null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/** Latest yt-dlp release tag, e.g. "2026.10.07" (null when offline). */
async function latestVersion() {
  const loc = await headLocation('https://github.com/yt-dlp/yt-dlp/releases/latest');
  const m = loc && /\/tag\/([^/?#]+)/.exec(loc);
  return m ? m[1] : null;
}

function binVersion(bin) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn(bin, ['--version'], { windowsHide: true }); } catch (_) { return resolve(null); }
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(out.trim() || null));
  });
}

/**
 * Make sure the cached yt-dlp is the latest release (YouTube breaks old
 * versions quickly). Checked at most once a day unless `force`.
 */
let updating = null;
async function ensureLatest(bin, force = false) {
  if (process.env.LAS_YTDLP_NO_UPDATE) return;
  if (updating) return updating;
  updating = (async () => {
    const stamp = path.join(cacheDir(), '.last-update');
    try { if (!force && Date.now() - fs.statSync(stamp).mtimeMs < UPDATE_INTERVAL_MS) return; } catch (_) {}
    const [latest, current] = await Promise.all([latestVersion(), binVersion(bin)]);
    log(`version check: installed=${current} latest=${latest}`);
    if (!latest) return; // offline: keep what we have, retry next time
    try { fs.writeFileSync(stamp, String(Date.now())); } catch (_) {}
    if (current === latest) return;
    try {
      await httpsDownload(RELEASE_URL, bin);
      log(`updated yt-dlp ${current} -> ${await binVersion(bin)}`);
    } catch (e) {
      log(`update failed: ${e.message}`);
    }
  })().finally(() => { updating = null; });
  return updating;
}

let resolving = null;
/** Resolve a runnable yt-dlp: { cmd, prefixArgs }. */
function resolveYtDlp() {
  if (process.env.LAS_YTDLP) return Promise.resolve({ cmd: process.env.LAS_YTDLP, prefixArgs: [] });
  if (resolving) return resolving;
  resolving = (async () => {
    const cached = cachedBinary();
    if (!fs.existsSync(cached)) {
      fs.mkdirSync(cacheDir(), { recursive: true });
      const bundled = bundledBinary();
      try {
        if (bundled) { fs.copyFileSync(bundled, cached); fs.chmodSync(cached, 0o755); }
        else await httpsDownload(RELEASE_URL, cached);
      } catch (e) {
        console.warn(`[yt-dlp] could not install standalone binary: ${e.message}`);
        if (bundled) return { cmd: bundled, prefixArgs: [] };
        const sys = onPath('yt-dlp');
        if (sys) return { cmd: sys, prefixArgs: [] };
        return { cmd: IS_WIN ? 'py' : 'python3', prefixArgs: ['-m', 'yt_dlp'] };
      }
    }
    await ensureLatest(cached);
    return { cmd: cached, prefixArgs: [] };
  })().finally(() => { setTimeout(() => { resolving = null; }, 0); });
  return resolving;
}

function run(cmd, args, timeoutMs, onLine, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new YtDlpError('Download cancelled.', 'cancelled'));
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); } catch (e) { return reject(e); }
    let out = ''; let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} reject(new YtDlpError('yt-dlp timed out', 'timeout')); }, timeoutMs);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        try { child.kill(IS_WIN ? undefined : 'SIGINT'); } catch (_) {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 3000).unref();
        reject(new YtDlpError('Download cancelled.', 'cancelled'));
      }, { once: true });
    }
    let partial = '';
    child.stdout.on('data', (d) => {
      out += d; if (out.length > 32e6) out = out.slice(-32e6);
      if (onLine) {
        const lines = (partial + d).split(/\r?\n|\r/);
        partial = lines.pop();
        for (const l of lines) { try { onLine(l); } catch (_) {} }
      }
    });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('error', (e) => { clearTimeout(timer); reject(e.code === 'ENOENT' ? new Error('yt-dlp is not available and could not be downloaded automatically.') : e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

let logger = null;
/** Optional diagnostics sink: fn(message). */
function setLogger(fn) { logger = typeof fn === 'function' ? fn : null; }
function log(msg) { if (logger) { try { logger(`[yt-dlp] ${msg}`); } catch (_) {} } }

// ------------------------------------------------------------ JS runtime

/** Bundled / configured deno, used by yt-dlp to solve YouTube JS challenges. */
function denoPath() {
  if (process.env.LAS_DENO && fs.existsSync(process.env.LAS_DENO)) return process.env.LAS_DENO;
  const name = IS_WIN ? 'deno.exe' : 'deno';
  const dirs = [];
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'bin'));
  dirs.push(path.join(__dirname, '..', 'resources', 'bin'), cacheDir());
  for (const d of dirs) { const p = path.join(d, name); if (fs.existsSync(p)) return p; }
  return onPath('deno');
}

// --------------------------------------------------------------- settings

const COOKIE_BROWSERS = ['chrome', 'edge', 'brave', 'firefox', 'avast'];
function settingsFile() { return path.join(path.dirname(cacheDir()), 'las-settings.json'); }
function cookiesFile() { return path.join(path.dirname(cacheDir()), 'youtube-cookies.txt'); }

/** { cookies: { mode: 'auto'|'none'|'file'|'browser', browser } } */
function getSettings() {
  let st = {};
  try { st = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch (_) {}
  const c = st.cookies || {};
  return {
    cookies: {
      mode: ['auto', 'none', 'file', 'browser'].includes(c.mode) ? c.mode : 'auto',
      browser: COOKIE_BROWSERS.includes(c.browser) ? c.browser : 'chrome',
      hasFile: fs.existsSync(cookiesFile()),
    },
  };
}

function saveSettings(patch = {}) {
  const cur = getSettings();
  const c = patch.cookies || {};
  const next = { cookies: { mode: c.mode || cur.cookies.mode, browser: c.browser || cur.cookies.browser } };
  if (!['auto', 'none', 'file', 'browser'].includes(next.cookies.mode)) throw new Error('Invalid cookies mode');
  if (!COOKIE_BROWSERS.includes(next.cookies.browser)) throw new Error('Unsupported browser');
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  log(`settings saved: ${JSON.stringify(next)}`);
  return getSettings();
}

/** Validate + store a Netscape cookies.txt (copied into userData). */
function importCookiesFile(srcPath) {
  const text = fs.readFileSync(srcPath, 'utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#') || l.startsWith('#HttpOnly_'));
  const valid = lines.filter((l) => l.split('\t').length >= 7);
  if (!valid.length) throw new Error('That file is not a Netscape cookies.txt (no tab-separated cookie lines found).');
  const domains = [...new Set(valid.map((l) => l.split('\t')[0].replace(/^#HttpOnly_/, '').replace(/^\./, '').toLowerCase()))];
  fs.mkdirSync(path.dirname(cookiesFile()), { recursive: true });
  fs.writeFileSync(cookiesFile(), text, { mode: 0o600 });
  log(`cookies.txt imported (${valid.length} cookies; domains: ${domains.slice(0, 15).join(', ')})`);
  return saveSettings({ cookies: { mode: 'file' } });
}

/** yt-dlp --cookies-from-browser value for a browser key. */
function browserSpec(key) {
  if (key === 'avast') {
    // Avast Secure Browser is Chromium; point yt-dlp at its profile folder.
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return `chromium:${path.join(base, 'AVAST Software', 'Browser', 'User Data', 'Default')}`;
  }
  return key;
}

function isBotError(err) {
  return /not a bot|Sign in to confirm|HTTP Error 429|Too Many Requests|cookies-from-browser|--cookies for the authentication|login required|log in|logged-in|requires? (?:a )?login|private video|only available for registered users|account/i.test(String(err || ''));
}

class YtDlpError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/** Options shared by every run: JS runtime, retries, gentle request pacing. */
function commonArgs() {
  const args = [];
  const deno = denoPath();
  if (deno) args.push('--js-runtimes', `deno:${deno}`);
  // Network robustness for slow / flaky connections: short socket timeout
  // with many retries, resume .part files, chunked HTTP (avoids throttled
  // single long requests) and parallel DASH fragments.
  // Hosted mode: route yt-dlp through a (residential) proxy, e.g. to get past
  // YouTube's datacenter bot check: LAS_PROXY=http://user:pass@host:port or socks5://...
  if (process.env.LAS_PROXY) args.push('--proxy', process.env.LAS_PROXY);
  args.push('--socket-timeout', '30', '--retries', '20', '--fragment-retries', '20', '--file-access-retries', '10',
    '--extractor-retries', '3', '--retry-sleep', 'http:exp=1:20', '--retry-sleep', 'fragment:exp=1:20', '--retry-sleep', 'extractor:exp=1:10',
    '--continue', '--http-chunk-size', '5M', '--concurrent-fragments', '4', '--sleep-requests', '0.5');
  return args;
}

/**
 * Run yt-dlp with escalating fallbacks for YouTube's bot checks / 429s:
 *   1. default clients (+ configured cookies)
 *   2. alternative player clients + EJS scripts fetched from GitHub
 *   3. cookies from installed browsers (chrome, edge, brave, firefox, avast)
 */
/**
 * Server-side cookies for hosted deployments: SERVER_COOKIES (cookies.txt
 * content, e.g. from a platform secret) or LAS_SERVER_COOKIES_FILE (path to a
 * mounted secret file). yt-dlp rewrites the cookie jar, so we use a private copy.
 */
let serverCookiesPath;
function serverCookies() {
  if (serverCookiesPath !== undefined) return serverCookiesPath;
  serverCookiesPath = null;
  try {
    let text = process.env.SERVER_COOKIES || '';
    if (!text && process.env.LAS_SERVER_COOKIES_FILE && fs.existsSync(process.env.LAS_SERVER_COOKIES_FILE)) {
      text = fs.readFileSync(process.env.LAS_SERVER_COOKIES_FILE, 'utf8');
    }
    if (text.trim()) {
      if (!/\t/.test(text)) text = text.replace(/\\t/g, '\t').replace(/\\n/g, '\n'); // env vars with escaped tabs/newlines
      const p = path.join(os.tmpdir(), `las-server-cookies-${process.pid}.txt`);
      fs.writeFileSync(p, text, { mode: 0o600 });
      serverCookiesPath = p;
      log(`server cookies loaded (${text.split(/\n/).filter((l) => l.split('\t').length >= 7).length} cookies)`);
    }
  } catch (e) { log(`server cookies failed: ${e.message}`); }
  return serverCookiesPath;
}

/** Abuse caps for hosted mode (also honoured locally when set). */
function maxDurationFor(kind, override = 0) {
  if (override > 0) return override; // per-plan limit (SaaS mode)
  const v = parseInt(process.env.LAS_MAX_DURATION_SEC || '0', 10);
  if (kind !== 'audio' || v <= 0) return v;
  // Audio is ~30x smaller than video: allow long talks / sermons / lives as MP3.
  return parseInt(process.env.LAS_MAX_AUDIO_DURATION_SEC || String(Math.max(v, 4 * 3600)), 10);
}

function capArgs(kind = 'video', maxDurOverride = 0) {
  if (kind === 'info') return [];
  const a = [];
  const maxDur = maxDurationFor(kind, maxDurOverride);
  if (maxDur > 0) a.push('--match-filter', `duration <=? ${maxDur}`);
  if (process.env.LAS_MAX_FILESIZE) a.push('--max-filesize', process.env.LAS_MAX_FILESIZE);
  return a;
}

async function runWithFallbacks(args, timeoutMs, onLine, signal, kind = 'video', maxDur = 0) {
  const st = getSettings().cookies;
  const base = [...commonArgs(), ...capArgs(kind, maxDur)];
  const srv = serverCookies();
  const userCookies = srv ? ['--cookies', srv]
    : st.mode === 'file' && fs.existsSync(cookiesFile()) ? ['--cookies', cookiesFile()]
    : st.mode === 'browser' ? ['--cookies-from-browser', browserSpec(st.browser)] : [];
  const attempts = [
    { name: `default${userCookies.length ? ' + saved cookies' : ''}`, extra: userCookies },
    { name: 'alt player clients', extra: [...userCookies, '--extractor-args', 'youtube:player_client=default,tv_simply,android_vr,mweb', '--remote-components', 'ejs:github'], update: true },
  ];
  if (st.mode === 'auto' && !srv && !process.env.LAS_NO_BROWSER_COOKIES) {
    for (const b of COOKIE_BROWSERS.filter((x) => x !== 'avast' || IS_WIN)) attempts.push({ name: `cookies from ${b}`, extra: ['--cookies-from-browser', browserSpec(b)], browser: b });
  }
  let last = null;
  const failures = [];
  for (const att of attempts) {
    if (att.update) { try { const { cmd } = await resolveYtDlp(); await ensureLatest(cmd, true); } catch (_) {} }
    log(`attempt: ${att.name}`);
    const r = await runYtDlp([...base, ...att.extra, ...args], timeoutMs, onLine, signal);
    if (r.code === 0 && /does not pass filter/i.test(r.out + r.err)) {
      throw new YtDlpError(`This ${kind === 'audio' ? 'audio' : 'video'} is longer than the server limit (${Math.round(maxDurationFor(kind, maxDur) / 60)} min).${kind !== 'audio' ? ' Try "Audio only (MP3)".' : ''}`, 'too_long');
    }
    if (r.code === 0 && /File is larger than max-filesize|Aborting/i.test(r.out + r.err) && !r.out.trim().split(/\r?\n/).some((l) => l && !l.startsWith('LASPROG') && !l.startsWith('LASFMT') && !l.startsWith('['))) {
      throw new YtDlpError(`This file is larger than the server limit (${process.env.LAS_MAX_FILESIZE}).`, 'too_large');
    }
    if (r.code === 0) { if (failures.length) log(`succeeded with: ${att.name}`); return r; }
    last = r;
    const reason = lastErrorLine(r.err, r.code);
    failures.push(`${att.name}: ${reason}`);
    log(`attempt failed (${att.name}): ${reason}`);
    // Only escalate for bot/rate-limit/cookie problems; other errors are final.
    const cookieFail = att.browser && /cookie|database|decrypt|DPAPI|Permission|locked|could not find|failed to/i.test(r.err);
    // A 403 on the media stream usually means this player client's URLs were
    // rejected (PO token / SABR); the alternative clients typically work.
    const streamBlocked = att === attempts[0] && /HTTP Error 403|po_token|SABR|Requested format is not available/i.test(r.err);
    if (!isBotError(r.err) && !cookieFail && !streamBlocked) break;
  }
  const reason = lastErrorLine(last.err, last.code);
  const target = args[args.length - 1];
  const fb = friendlyFacebookError(String(target), `${reason}\n${failures.join('\n')}`);
  if (fb) throw new YtDlpError(fb, 'fb_unavailable');
  if (isBotError(failures.join('\n'))) {
    throw new YtDlpError(`The site needs you to be signed in or confirm you're not a bot (${reason}). Add cookies (from your browser or a cookies.txt) in Settings and try again.`, 'bot_check');
  }
  throw new YtDlpError(reason, /Unsupported URL/i.test(reason) ? 'unsupported' : 'ytdlp_failed');
}

async function runYtDlp(args, timeoutMs = 60000, onLine, signal) {
  const { cmd, prefixArgs } = await resolveYtDlp();
  log(`run ${cmd} ${[...prefixArgs, ...args].map((a, i, all) => (all[i - 1] === '--proxy' ? String(a).replace(/\/\/[^@/]*@/, '//***@') : a)).join(' ')}`);
  const r = await run(cmd, [...prefixArgs, ...args], timeoutMs, onLine, signal).catch((e) => { log(`spawn error: ${e.message}`); throw e; });
  log(`exit ${r.code}${r.code ? ` stderr: ${r.err.trim().slice(-1500)}` : ''}`);
  return r;
}

/**
 * Real metadata for the Analyze step (yt-dlp -J): title, duration and the
 * download options we offer with estimated sizes computed from real formats.
 */
const SHORT_LINK = /^https:\/\/(?:fb\.watch\/|(?:www\.|m\.|web\.)?facebook\.com\/share\/|vm\.tiktok\.com\/|vt\.tiktok\.com\/|(?:www\.)?tiktok\.com\/t\/|t\.co\/)/i;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

const FB_CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
function redirectOf(url, ua) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'GET', headers: { 'User-Agent': ua, Accept: 'text/html' }, timeout: 15000 }, (res) => {
      res.resume();
      resolve([301, 302, 303, 307, 308].includes(res.statusCode) ? res.headers.location : null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/** Follow redirects of share / short links (fb.watch, facebook.com/share/..., vm.tiktok.com, t.co). */
async function resolveShareUrl(url) {
  if (!SHORT_LINK.test(url)) return resolveFacebookPost(url);
  let cur = url;
  // Facebook answers /share/p/ (post) links from a desktop browser UA with
  // HTTP 400 and no redirect; its own link-preview crawler UA gets the 302.
  let ua = BROWSER_UA;
  for (let i = 0; i < 6; i++) {
    let loc = null;
    for (const tryUa of (i === 0 && /facebook\.com|fb\.watch/i.test(cur) ? [ua, FB_CRAWLER_UA] : [ua])) {
      loc = await redirectOf(cur, tryUa);
      if (loc) { ua = tryUa; break; }
    }
    if (!loc) break;
    const next = new URL(loc, cur).toString();
    if (!/^https:/i.test(next) || /\/login|checkpoint/i.test(next)) break; // keep original if it bounces to login
    cur = next;
  }
  if (cur !== url) log(`resolved share link ${url} -> ${cur}`);
  return resolveFacebookPost(cur);
}

// Facebook post links (/<page>/posts/pfbid..., permalink.php, story.php) answer
// HTTP 404 to logged-out / datacenter clients, so yt-dlp fails on them. The
// public video embed (plugins/video.php?href=<post>) still names the post's
// video id, and the plain watch URL for that id downloads fine.
const FB_POST = /^https:\/\/(?:www\.|m\.|web\.|mbasic\.)?facebook\.com\/(?:[^/?#]+\/posts\/|permalink\.php|story\.php|groups\/[^/?#]+\/(?:posts|permalink)\/)/i;
function httpsGetText(url, maxBytes = 1.5e6) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'GET', headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.8' }, timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(''); }
      let body = ''; res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > maxBytes) { req.destroy(); resolve(body); } });
      res.on('end', () => resolve(body));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.end();
  });
}
async function resolveFacebookPost(url) {
  if (!FB_POST.test(url)) return url;
  const html = await httpsGetText(`https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}`);
  const m = /"video_id":"?(\d{6,25})/.exec(html) || /\/videos\/(\d{6,25})/.exec(html);
  if (!m) { log(`facebook post: no video id found for ${url}`); return url; }
  const watch = `https://www.facebook.com/watch/?v=${m[1]}`;
  log(`resolved facebook post ${url} -> ${watch}`);
  return watch;
}

/** Turn a raw yt-dlp failure on a Facebook link into a message the user can act on. */
function friendlyFacebookError(url, reason) {
  if (!/facebook\.com|fb\.watch/i.test(url)) return null;
  if (/HTTP Error 404|login|log in|logged-in|Cannot parse data|No video formats|registered users/i.test(reason)) {
    return 'Facebook won\'t show this post to the server: it is private, needs login, or has no public video. Open the video itself and use Share → Copy link, then paste that link.';
  }
  return null;
}

async function getInfo(url, { maxVideoSec = 0, maxAudioSec = 0 } = {}) {
  url = await resolveShareUrl(url);
  const { out } = await runWithFallbacks(['--no-playlist', '-J', '--', url], 120000, undefined, undefined, 'info');
  let j;
  try { j = JSON.parse(out); } catch (e) { throw new Error('yt-dlp returned invalid metadata'); }
  const duration = Number(j.duration) || 0;
  const maxDur = maxDurationFor('video', maxVideoSec);
  const maxAudio = maxDurationFor('audio', maxAudioSec);
  if (maxAudio > 0 && duration > maxAudio) {
    throw new YtDlpError(`This video is ${Math.round(duration / 60)} min long; the server limit is ${Math.round(maxAudio / 60)} min.`, 'too_long');
  }
  const videoTooLong = maxDur > 0 && duration > maxDur;
  const fmts = Array.isArray(j.formats) ? j.formats : [];
  const size = (f) => f && (f.filesize || f.filesize_approx || (f.tbr && duration ? (f.tbr * 1000 / 8) * duration : 0)) || 0;
  const audios = fmts.filter((f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none');
  const bestAudio = audios.filter((f) => f.ext === 'm4a').sort((a, b) => (b.abr || 0) - (a.abr || 0))[0]
    || audios.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
  const heights = [...new Set(fmts.filter((f) => f.vcodec && f.vcodec !== 'none' && f.height).map((f) => f.height))]
    .sort((a, b) => b - a);
  const options = [];
  for (const h of heights) {
    const cands = fmts.filter((f) => f.height === h && f.vcodec && f.vcodec !== 'none');
    const pick = cands.find((f) => /^avc1/.test(f.vcodec || '')) || cands.find((f) => f.ext === 'mp4') || cands[0];
    const progressive = pick.acodec && pick.acodec !== 'none';
    const bytes = size(pick) + (progressive ? 0 : size(bestAudio));
    const kbps = Math.round((pick.tbr || pick.vbr || 0) + (progressive ? 0 : (bestAudio && bestAudio.abr) || 0));
    options.push({ tag: `${h}p`, kind: 'video', label: `${h}p MP4${/^avc1/.test(pick.vcodec || '') ? ' (H.264)' : ''}`, height: h, short: Math.min(h, pick.width || h), kbps, bytes: Math.round(bytes) });
  }
  // Formats without height info (e.g. Facebook "sd"/"hd"): offer them by format id.
  const noHeight = fmts.filter((f) => !f.height && f.format_id && /^[\w.-]+$/.test(f.format_id)
    && f.vcodec !== 'none' && f.ext !== 'mhtml' && !/storyboard/i.test(f.format_note || ''));
  const rank = (f) => (/^hd|high|best/i.test(f.format_id + (f.format_note || '')) ? 2 : /^sd|low/i.test(f.format_id) ? 1 : 0);
  if (!heights.length) {
    for (const f of noHeight.sort((a, b) => rank(b) - rank(a) || (b.tbr || 0) - (a.tbr || 0))) {
      const name = /^hd$/i.test(f.format_id) ? 'HD' : /^sd$/i.test(f.format_id) ? 'SD' : (f.format_note || f.format_id);
      options.push({ tag: `id:${f.format_id}`, kind: 'video', label: `${name} ${String(f.ext || 'mp4').toUpperCase()}`,
        kbps: Math.round(f.tbr || 0), bytes: Math.round(size(f)) });
    }
  }
  if (!options.length) options.push({ tag: 'best', kind: 'video', label: 'Best available (MP4)', kbps: 0, bytes: 0 });
  if (videoTooLong) options.length = 0; // only audio fits the server limits
  options.push({ tag: 'mp3', kind: 'audio', label: 'Audio only (MP3 192 kbps)', kbps: 192, bytes: Math.round(duration * 192000 / 8) });
  return {
    note: videoTooLong ? `This video is ${Math.round(duration / 60)} min long; the server allows video up to ${Math.round(maxDur / 60)} min, so only MP3 audio is offered.` : '',
    id: j.id, title: j.title || j.id, uploader: j.uploader || j.channel || j.uploader_id || '', duration,
    extractor: j.extractor_key || j.extractor || '',
    thumbnail: j.thumbnail || '', webpageUrl: j.webpage_url || url, options,
  };
}

function lastErrorLine(err, code) {
  const lines = String(err || '').trim().split(/\r?\n/).filter((l) => /ERROR/i.test(l));
  return (lines.pop() || String(err || '').trim().split(/\r?\n/).pop() || `yt-dlp exited with code ${code}`).replace(/^ERROR:\s*/, '');
}

/**
 * Download `url` into a fresh temp dir. kind: 'video' (mp4) | 'audio' (mp3).
 * Resolves { file, dir, title, ext }. Caller must remove `dir`.
 */
/** Network-level failures worth an automatic resume (not site/format errors). */
function isNetworkError(text) {
  return /timed out|Read timed out|Giving up after|Connection (?:reset|aborted|refused)|RemoteDisconnected|IncompleteRead|urlopen error|Temporary failure|Network is unreachable|EOF occurred|ECONNRESET|did not get any data|HTTP Error 5\d\d|got only \d+ bytes/i.test(String(text || ''));
}

/** Stable per-URL+format work dir so a retry resumes the .part files. */
function workDir(url, kind, q, formatId) {
  const key = crypto.createHash('sha1').update(`${url}|${kind}|${q}|${formatId || ''}`).digest('hex').slice(0, 16);
  const dir = path.join(os.tmpdir(), `las-ytdl-${key}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** yt-dlp format selection. Exported for tests. */
function formatArgs(kind, q, bitrate, formatId, maxShortSide = 0) {
  if (kind === 'audio') {
    // Audio-only stream when the site has one (never pull the full video for
    // an MP3); otherwise the smallest format that contains audio.
    return ['-f', 'ba/wa*/w', '-x', '--audio-format', 'mp3', '--audio-quality', `${bitrate}K`];
  }
  if (formatId) return ['-f', `${formatId}+ba/${formatId}/b`, '--merge-output-format', 'mp4', '--remux-video', 'mp4'];
  // Sort instead of filtering on height: formats without a height (Facebook
  // "sd"/"hd", many other sites) then fall back to the SMALLEST file, not the
  // biggest. Prefer the requested height (or the closest below), then H.264/AAC.
  // If no format has a known height (e.g. Facebook "sd"/"hd"), a low quality
  // request takes the worst (smallest) file and a high one the best.
  const fallback = q <= 480 ? 'w' : 'b';
  if (maxShortSide > 0) {
    // Plan cap on the SHORT side (720 = HD 720p for landscape and portrait/reels alike).
    const c = maxShortSide;
    const capped = (sel) => [`${sel}[height<=?${c}]`, `${sel}[width<=?${c}]`];
    const sel = [
      ...capped(`bv*[height<=${q}]`).map((v) => `${v}+ba`), ...capped(`b[height<=${q}]`),
      ...capped('bv*').map((v) => `${v}+ba`), ...capped('b'),
    ].join('/');
    return ['-f', sel, '-S', `res:${q},vcodec:h264,acodec:aac,+size,+br`, '--merge-output-format', 'mp4', '--remux-video', 'mp4'];
  }
  return ['-f', `bv*[height<=${q}]+ba/b[height<=${q}]/${fallback}`, '-S', `res:${q},vcodec:h264,acodec:aac,+size,+br`, '--merge-output-format', 'mp4', '--remux-video', 'mp4'];
}

async function downloadMedia(url, { kind = 'video', quality = 720, bitrate = 192, formatId = '', timeoutMs = 3 * 3600e3, onProgress, onStatus, signal, maxAttempts = 3, maxDurationSec = 0, maxShortSide = 0 } = {}) {
  url = await resolveShareUrl(url);
  if (formatId && !/^[\w.-]{1,40}$/.test(formatId)) throw new YtDlpError('Invalid format id', 'bad_request');
  const q = Number.isInteger(quality) && quality > 0 && quality <= 4320 ? quality : 720;
  const dir = workDir(url, kind, q, formatId);
  const args = ['--no-playlist', '--newline', '--progress', '--progress-template',
    'download:LASPROG %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes,progress.total_bytes_estimate)s',
    '--restrict-filenames', '--ffmpeg-location', FFMPEG_PATH, '-P', dir, '-o', '%(title).80B.%(ext)s', '--print', 'before_dl:LASFMT %(format_id)s', '--print', 'after_move:filepath',
    ...formatArgs(kind, q, bitrate, maxShortSide ? '' : formatId, maxShortSide), '--', url];
  // Video+audio are two downloads; map them onto 0-90%, merge/convert = 90-99%.
  let part = 0; let lastPct = -1; let parts = kind === 'audio' ? 1 : 2;
  const onLine = (line) => {
    if (!onProgress) return;
    const fm = /^LASFMT\s+(\S+)/.exec(line.trim());
    if (fm) { parts = fm[1].includes('+') ? 2 : 1; return; }
    const m = /^LASPROG\s+([\d.]+)%\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)$/.exec(line.trim());
    if (m) {
      const pct = parseFloat(m[1]);
      if (pct < lastPct - 50) part++;
      lastPct = pct;
      const clean = (v) => { v = String(v || '').trim(); return /^(NA|None|Unknown)/i.test(v) ? '' : v; };
      onProgress(Math.min(90, Math.round(((Math.min(part, parts - 1) + pct / 100) / parts) * 90)), {
        speed: clean(m[2]), eta: clean(m[3]), downloaded: parseInt(m[4], 10) || 0, total: parseInt(m[5], 10) || 0,
      });
    } else if (/^\[(Merger|ExtractAudio|VideoRemuxer)\]/.test(line)) onProgress(95, { stage: 'Converting…' });
  };
  let res; let attempt = 0;
  for (;;) {
    attempt++;
    try {
      res = await runWithFallbacks(args, timeoutMs, onLine, signal, kind, maxDurationSec);
    } catch (e) {
      if (e && e.code === 'cancelled') { fs.rm(dir, { recursive: true, force: true }, () => {}); throw e; }
      if (attempt < maxAttempts && (e.code === 'timeout' || isNetworkError(e.message))) {
        log(`network error, retry ${attempt}/${maxAttempts - 1} (resuming): ${e.message}`);
        if (onStatus) onStatus(`Connection slow, retrying… (resuming, attempt ${attempt + 1}/${maxAttempts})`);
        part = 0; lastPct = -1;
        await new Promise((r) => setTimeout(r, 3000 * attempt));
        continue;
      }
      if (e.code !== 'timeout' && !isNetworkError(e.message)) fs.rm(dir, { recursive: true, force: true }, () => {});
      if (isNetworkError(e.message)) throw new YtDlpError(`The connection kept timing out (${e.message}). Tap Download again to resume where it stopped.`, 'network');
      throw e;
    }
    break;
  }
  const { code, out } = res;
  const file = out.trim().split(/\r?\n/).filter((l) => l && !l.startsWith('LASPROG') && !l.startsWith('LASFMT') && !l.startsWith('[')).pop();
  if (code !== 0 || !file || !fs.existsSync(file)) {
    fs.rm(dir, { recursive: true, force: true }, () => {});
    if (code === 0 && capArgs(kind, maxDurationSec).length) {
      throw new YtDlpError(`Skipped: the video is over the server limit (max ${Math.round(maxDurationFor(kind, maxDurationSec) / 60) || '∞'} min${process.env.LAS_MAX_FILESIZE ? `, ${process.env.LAS_MAX_FILESIZE}` : ''}).`, 'over_limit');
    }
    throw new Error(lastErrorLine(res.err, code));
  }
  return { file, dir, ext: path.extname(file).slice(1), title: path.basename(file, path.extname(file)) };
}

module.exports = { resolveFacebookPost, friendlyFacebookError, formatArgs, isNetworkError, workDir, resolveShareUrl, denoPath, getSettings, saveSettings, importCookiesFile, cookiesFile, isBotError, YtDlpError, COOKIE_BROWSERS, ensureLatest, latestVersion, resolveYtDlp, runYtDlp, downloadMedia, getInfo, setLogger, lastErrorLine, RELEASE_ASSET, cachedBinary, bundledBinary };
