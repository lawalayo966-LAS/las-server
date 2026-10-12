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

function run(cmd, args, timeoutMs, onLine) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); } catch (e) { return reject(e); }
    let out = ''; let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} reject(new Error('yt-dlp timed out')); }, timeoutMs);
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
  args.push('--retries', '5', '--extractor-retries', '3', '--retry-sleep', 'http:exp=1:20', '--retry-sleep', 'extractor:exp=1:10',
    '--sleep-requests', '0.5');
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
function capArgs() {
  const a = [];
  const maxDur = parseInt(process.env.LAS_MAX_DURATION_SEC || '0', 10);
  if (maxDur > 0) a.push('--match-filter', `duration <=? ${maxDur}`);
  if (process.env.LAS_MAX_FILESIZE) a.push('--max-filesize', process.env.LAS_MAX_FILESIZE);
  return a;
}

async function runWithFallbacks(args, timeoutMs, onLine) {
  const st = getSettings().cookies;
  const base = [...commonArgs(), ...capArgs()];
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
    const r = await runYtDlp([...base, ...att.extra, ...args], timeoutMs, onLine);
    if (r.code === 0 && /does not pass filter/i.test(r.out + r.err)) {
      throw new YtDlpError(`This video is longer than the server limit (${Math.round(parseInt(process.env.LAS_MAX_DURATION_SEC, 10) / 60)} min).`, 'too_long');
    }
    if (r.code === 0 && /File is larger than max-filesize|Aborting/i.test(r.out + r.err) && !r.out.trim().split(/\r?\n/).some((l) => l && !l.startsWith('LASPROG') && !l.startsWith('['))) {
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
  if (isBotError(failures.join('\n'))) {
    throw new YtDlpError(`The site needs you to be signed in or confirm you're not a bot (${reason}). Add cookies (from your browser or a cookies.txt) in Settings and try again.`, 'bot_check');
  }
  throw new YtDlpError(reason, /Unsupported URL/i.test(reason) ? 'unsupported' : 'ytdlp_failed');
}

async function runYtDlp(args, timeoutMs = 60000, onLine) {
  const { cmd, prefixArgs } = await resolveYtDlp();
  log(`run ${cmd} ${[...prefixArgs, ...args].join(' ')}`);
  const r = await run(cmd, [...prefixArgs, ...args], timeoutMs, onLine).catch((e) => { log(`spawn error: ${e.message}`); throw e; });
  log(`exit ${r.code}${r.code ? ` stderr: ${r.err.trim().slice(-1500)}` : ''}`);
  return r;
}

/**
 * Real metadata for the Analyze step (yt-dlp -J): title, duration and the
 * download options we offer with estimated sizes computed from real formats.
 */
const SHORT_LINK = /^https:\/\/(?:fb\.watch\/|(?:www\.|m\.|web\.)?facebook\.com\/share\/|vm\.tiktok\.com\/|vt\.tiktok\.com\/|(?:www\.)?tiktok\.com\/t\/|t\.co\/)/i;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

/** Follow redirects of share / short links (fb.watch, facebook.com/share/..., vm.tiktok.com, t.co). */
async function resolveShareUrl(url) {
  if (!SHORT_LINK.test(url)) return url;
  let cur = url;
  for (let i = 0; i < 6; i++) {
    const loc = await new Promise((resolve) => {
      const req = https.request(cur, { method: 'GET', headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' }, timeout: 15000 }, (res) => {
        res.resume();
        resolve([301, 302, 303, 307, 308].includes(res.statusCode) ? res.headers.location : null);
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });
    if (!loc) break;
    const next = new URL(loc, cur).toString();
    if (!/^https:/i.test(next) || /\/login|checkpoint/i.test(next)) break; // keep original if it bounces to login
    cur = next;
  }
  if (cur !== url) log(`resolved share link ${url} -> ${cur}`);
  return cur;
}

async function getInfo(url) {
  url = await resolveShareUrl(url);
  const { out } = await runWithFallbacks(['--no-playlist', '-J', '--', url], 120000);
  let j;
  try { j = JSON.parse(out); } catch (e) { throw new Error('yt-dlp returned invalid metadata'); }
  const duration = Number(j.duration) || 0;
  const maxDur = parseInt(process.env.LAS_MAX_DURATION_SEC || '0', 10);
  if (maxDur > 0 && duration > maxDur) {
    throw new YtDlpError(`This video is ${Math.round(duration / 60)} min long; the server limit is ${Math.round(maxDur / 60)} min.`, 'too_long');
  }
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
    options.push({ tag: `${h}p`, kind: 'video', label: `${h}p MP4${/^avc1/.test(pick.vcodec || '') ? ' (H.264)' : ''}`, height: h, kbps, bytes: Math.round(bytes) });
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
  options.push({ tag: 'mp3', kind: 'audio', label: 'Audio only (MP3 192 kbps)', kbps: 192, bytes: Math.round(duration * 192000 / 8) });
  return {
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
async function downloadMedia(url, { kind = 'video', quality = 720, bitrate = 192, formatId = '', timeoutMs = 30 * 60000, onProgress } = {}) {
  url = await resolveShareUrl(url);
  if (formatId && !/^[\w.-]{1,40}$/.test(formatId)) throw new YtDlpError('Invalid format id', 'bad_request');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'las-ytdl-'));
  const q = Number.isInteger(quality) && quality > 0 && quality <= 4320 ? quality : 720;
  const args = ['--no-playlist', '--newline', '--progress', '--progress-template', 'download:LASPROG %(progress._percent_str)s', '--restrict-filenames',
    '--ffmpeg-location', FFMPEG_PATH, '-P', dir, '-o', '%(title).80B.%(ext)s', '--print', 'after_move:filepath'];
  if (kind === 'audio') {
    args.push('-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', `${bitrate}K`);
  } else {
    if (formatId) {
      args.push('-f', `${formatId}+ba/${formatId}/b`, '--merge-output-format', 'mp4', '--remux-video', 'mp4');
    } else
    // Prefer H.264 (plays everywhere), then any mp4, then anything.
    args.push('-f', `bv*[height<=${q}][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=${q}][ext=mp4]+ba[ext=m4a]/b[height<=${q}][ext=mp4]/bv*[height<=${q}]+ba/b[height<=${q}]/b`,
      '--merge-output-format', 'mp4', '--remux-video', 'mp4');
  }
  args.push('--', url);
  // Video+audio are two downloads; map them onto 0-90%, merge/convert = 90-99%.
  let part = 0; let lastPct = -1;
  let res;
  try {
    res = await runWithFallbacks(args, timeoutMs, (line) => {
    if (!onProgress) return;
    const m = /^LASPROG\s+([\d.]+)%/.exec(line.trim());
    if (m) {
      const pct = parseFloat(m[1]);
      if (pct < lastPct - 50) part++;
      lastPct = pct;
      const parts = kind === 'audio' ? 1 : 2;
      onProgress(Math.min(90, Math.round(((Math.min(part, parts - 1) + pct / 100) / parts) * 90)));
    } else if (/^\[(Merger|ExtractAudio|VideoRemuxer)\]/.test(line)) onProgress(95);
    });
  } catch (e) {
    fs.rm(dir, { recursive: true, force: true }, () => {});
    throw e;
  }
  const { code, out, err } = res;
  const file = out.trim().split(/\r?\n/).filter((l) => l && !l.startsWith('LASPROG') && !l.startsWith('[')).pop();
  if (code !== 0 || !file || !fs.existsSync(file)) {
    fs.rm(dir, { recursive: true, force: true }, () => {});
    if (code === 0 && capArgs().length) {
      throw new YtDlpError(`Skipped: the video is over the server limit (max ${Math.round(parseInt(process.env.LAS_MAX_DURATION_SEC || '0', 10) / 60) || '∞'} min${process.env.LAS_MAX_FILESIZE ? `, ${process.env.LAS_MAX_FILESIZE}` : ''}).`, 'over_limit');
    }
    throw new Error(lastErrorLine(err, code));
  }
  return { file, dir, ext: path.extname(file).slice(1), title: path.basename(file, path.extname(file)) };
}

module.exports = { resolveShareUrl, denoPath, getSettings, saveSettings, importCookiesFile, cookiesFile, isBotError, YtDlpError, COOKIE_BROWSERS, ensureLatest, latestVersion, resolveYtDlp, runYtDlp, downloadMedia, getInfo, setLogger, lastErrorLine, RELEASE_ASSET, cachedBinary, bundledBinary };
