/**
 * Checks if a URL points to a streaming platform (YouTube, TikTok, Vimeo, etc.)
 */
const DIRECT_MEDIA_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|flv|wmv|mp3|m4a|aac|wav|flac|ogg|opus|wma|m3u8|mpd|zip|pdf|jpe?g|png|gif)$/i;

/** Direct link to a media/file (downloaded as-is, no yt-dlp). */
export function isDirectFileUrl(url = '') {
  try { return DIRECT_MEDIA_EXT.test(new URL(url).pathname); } catch (_) { return false; }
}

/**
 * Any web page URL goes through yt-dlp (it supports 1800+ sites: YouTube,
 * Facebook incl. share/reel/fb.watch/m./web., Instagram, TikTok, X, Vimeo, ...).
 * Previously only a short hard-coded list was accepted, so Facebook never
 * reached yt-dlp.
 */
export function isStreamingPlatform(url = '') {
  if (!/^https?:\/\//i.test(String(url))) return false;
  return !isDirectFileUrl(url);
}

/**
 * Validate a user-supplied media URL. Throws a user-facing error for empty,
 * malformed or non-http(s) input (no silent defaults).
 */
export function validateMediaUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) {
    throw new DownloadServiceError('Please paste a media URL first.', { code: 'invalid_url' });
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw new DownloadServiceError('That does not look like a valid URL.', { code: 'invalid_url' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DownloadServiceError('Only http:// and https:// URLs are supported.', { code: 'invalid_url' });
  }
  return parsed.href;
}

/**
 * Robust media downloader that works on Web, Electron, and iOS/Android Capacitor
 * Automatically resolves YouTube & stream links via extraction backend/API
 * @param {string} mediaUrl - Direct media URL or YouTube/streaming link
 * @param {string} fileName - Desired output file name
 * @param {Function} onProgress - Callback (percent)
 * @returns {Promise<{success: boolean, url?: string}>}
 */
/**
 * Resolves the backend base URL (handles http://localhost:3000, file://, Capacitor, and Electron)
 */
export function getApiBaseUrl() {
  // Explicit override (needed on Android/iOS, where the app has no local
  // server): window.LAS_API_BASE or localStorage "las_api_base", e.g.
  // "http://192.168.1.20:3000" for a PC running `npm run serve`.
  try {
    const configured = (typeof window !== 'undefined' && (window.LAS_API_BASE
      || (window.localStorage && window.localStorage.getItem('las_api_base')))) || '';
    if (configured) return String(configured).replace(/\/+$/, '');
  } catch (_) {}
  if (isNativeApp()) return builtinServer();
  if (typeof window !== 'undefined' && window.location && window.location.origin && window.location.origin.startsWith('http')) {
    return window.location.origin;
  }
  return 'http://localhost:3000';
}

/** Hosted server baked into the mobile build ('' while still a placeholder). */
export function builtinServer() {
  const v = (typeof window !== 'undefined' && window.LAS_BUILTIN_SERVER) || '';
  return /^https?:\/\//.test(v) ? v.replace(/\/+$/, '') : '';
}

/** Token for the hosted server (user override first, then the built-in one). */
export function apiToken() {
  try {
    const own = window.localStorage && window.localStorage.getItem('las_api_base');
    if (own) return window.localStorage.getItem('las_api_token') || '';
  } catch (_) {}
  const t = (typeof window !== 'undefined' && window.LAS_BUILTIN_TOKEN) || '';
  return /^__/.test(t) ? '' : t;
}

/**
 * Capacitor plugins through the native bridge's global. The Android build ships
 * the unbundled src/ files, so bare imports such as import('@capacitor/filesystem')
 * cannot be resolved in the WebView ("Failed to resolve module specifier"). That
 * broke every download in v1.7 before it even reached the server.
 */
const Directory = { Documents: 'DOCUMENTS', Data: 'DATA', Cache: 'CACHE', External: 'EXTERNAL', ExternalStorage: 'EXTERNAL_STORAGE' };
const pluginCache = {};
export function capPlugin(name) {
  const C = typeof window !== 'undefined' && window.Capacitor;
  if (!C) throw new DownloadServiceError(`Capacitor plugin ${name} is not available.`, { code: 'no_plugin' });
  if (!pluginCache[name]) pluginCache[name] = (C.Plugins && C.Plugins[name]) || C.registerPlugin(name);
  return pluginCache[name];
}
function capFilesystem() { return { Filesystem: capPlugin('Filesystem'), Directory }; }

/** Mobile debug log: a ring buffer the user can copy from the Download tab. */
const debugLines = [];
export function debugLog(msg) {
  const line = `${new Date().toISOString()} ${String(msg).replace(/([?&]token=)[^&\s]+/g, '$1***')}`;
  debugLines.push(line); if (debugLines.length > 300) debugLines.shift();
  try { console.log('[LAS]', line); } catch (_) {}
}
export function getDebugLog() { return debugLines.join('\n'); }

export function isNativeApp() {
  return typeof window !== 'undefined' && !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

/** Persist the download server used by the mobile app ("" clears it). */
export function setApiBaseUrl(url) {
  const v = String(url || '').trim().replace(/\/+$/, '');
  if (v) new URL(v); // throws on garbage
  if (v) window.localStorage.setItem('las_api_base', v);
  else window.localStorage.removeItem('las_api_base');
  return v;
}

function requireApiBase() {
  const base = getApiBaseUrl();
  if (!base) {
    throw new DownloadServiceError(
      'This build has no built-in download server yet. Enter a LAS CONVERT server under Settings > Download server (advanced), '
      + 'e.g. a PC on your Wi-Fi running "npm run serve" with LAS_HOST=0.0.0.0 LAS_ALLOWED_HOSTS=<pc-ip>.',
      { code: 'no_endpoints' }
    );
  }
  return base;
}

/** URL of the server-side yt-dlp download (mp4 video or mp3 audio). */
export function mediaDownloadUrl(pageUrl, { audio = false, quality = 720, bitrate = 192, formatId = '' } = {}) {
  const base = requireApiBase();
  const q = new URLSearchParams({ url: pageUrl, format: audio ? 'mp3' : 'mp4', quality: String(quality), bitrate: String(bitrate) });
  if (formatId) q.set('formatId', formatId);
  if (apiToken()) q.set('token', apiToken());
  return `${base}/api/media-download?${q}`;
}

async function readServerError(res) {
  const text = await res.text().catch(() => '');
  try { return JSON.parse(text).error || text; } catch (_) { return text; }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new DownloadServiceError('Download cancelled.', { code: 'cancelled' })); }, { once: true });
});

function fmtBytes(n) { return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(0, Math.round(n / 1024))} KB`; }
function fmtEta(sec) {
  if (!isFinite(sec) || sec <= 0) return '';
  const m = Math.floor(sec / 60); const s2 = Math.round(sec % 60);
  return m ? `${m}:${String(s2).padStart(2, '0')}` : `0:${String(s2).padStart(2, '0')}`;
}

/** fetch with a per-request timeout, cancellable through `signal`. */
async function fetchT(url, opts = {}, timeoutMs = 30000, signal) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  if (signal) { if (signal.aborted) ctl.abort(); signal.addEventListener('abort', onAbort, { once: true }); }
  // On Android, CapacitorHttp patches fetch() through the native bridge, which
  // ignores AbortSignal and base64-encodes binary bodies. The server sends
  // proper CORS headers, so use the WebView's own fetch (kept by Capacitor as
  // CapacitorWebFetch): real timeouts/cancel and binary Range chunks.
  const f = (typeof window !== 'undefined' && window.CapacitorWebFetch) || fetch;
  try { return await f(url, { ...opts, signal: ctl.signal, cache: 'no-store' }); } finally {
    clearTimeout(t); if (signal) signal.removeEventListener('abort', onAbort);
    if (signal && signal.aborted) throw new DownloadServiceError('Download cancelled.', { code: 'cancelled' }); // eslint-disable-line no-unsafe-finally
  }
}

/**
 * Job-based server download: start a job, poll its progress (short requests),
 * then fetch the finished file in Range chunks, retrying and resuming each
 * chunk on a slow or flaky connection. `sink(chunk:Uint8Array)` receives the
 * bytes in order. Returns { name, size, mime }.
 */
async function serverJobDownload(base, pageUrl, { audio, quality, bitrate, formatId, onProgress, onStatus, signal, sink }) {
  const headers = apiToken() ? { 'X-LAS-Token': apiToken() } : {};
  const q = new URLSearchParams({ url: pageUrl, format: audio ? 'mp3' : 'mp4', quality: String(quality), bitrate: String(bitrate) });
  if (formatId) q.set('formatId', formatId);
  let res;
  for (let i = 0; ; i++) {
    try { res = await fetchT(`${base}/api/jobs?${q}`, { method: 'POST', headers }, 45000, signal); break; } catch (e) {
      debugLog(`job POST error: ${e.message}`);
      if (e.code === 'cancelled' || i >= 3) throw e.code ? e : new DownloadServiceError(`Could not reach the download server (${e.message}).`, { code: 'unreachable' });
      if (onStatus) onStatus('Connection slow, retrying…');
      await sleep(3000 * (i + 1), signal);
    }
  }
  debugLog(`job POST -> HTTP ${res.status}`);
  if (res.status === 404) return null; // old server without the job API
  let j = await res.json().catch(() => ({}));
  if (!res.ok) throw new DownloadServiceError(String(j.error || `Download failed (HTTP ${res.status})`).slice(0, 400), { code: j.code || 'service_error' });
  const id = j.id;
  const cancelJob = () => { fetch(`${base}/api/jobs/${id}`, { method: 'DELETE', headers }).catch(() => {}); };
  if (signal) signal.addEventListener('abort', cancelJob, { once: true });
  try {
    // 1. Server-side download (0-70%)
    let fails = 0;
    while (j.state === 'running') {
      await sleep(2000, signal);
      try {
        const r = await fetchT(`${base}/api/jobs/${id}`, { headers }, 30000, signal);
        const nj = await r.json();
        if (!r.ok) throw new DownloadServiceError(nj.error || `HTTP ${r.status}`, { code: nj.code || 'service_error' });
        j = nj; fails = 0;
        const pct = Math.round((j.percent || 0) * 0.7);
        if (onProgress) onProgress(pct, { stage: 'server', speed: j.speed, eta: j.eta, status: j.status });
        if (onStatus && /retrying/i.test(j.status || '')) onStatus(j.status);
      } catch (e) {
        if (e.code === 'cancelled' || e.code === 'no_job') throw e;
        debugLog(`poll failed: ${e.message}`);
        if (++fails > 20) throw new DownloadServiceError('Lost the connection to the download server.', { code: 'unreachable' });
        if (onStatus) onStatus('Connection slow, retrying…');
      }
    }
    if (j.state === 'error') debugLog(`job error: ${j.code} ${j.error}`);
    if (j.state === 'error') throw new DownloadServiceError(String(j.error || 'Download failed').slice(0, 400), { code: j.code || 'ytdlp_failed' });

    // 2. Transfer to the device in resumable chunks (70-100%)
    const size = j.size; const CHUNK = 4 * 1048576;
    let got = 0; const t0 = Date.now(); let tries = 0;
    while (got < size) {
      const end = Math.min(size, got + CHUNK) - 1;
      try {
        const r = await fetchT(`${base}/api/jobs/${id}/file`, { headers: { ...headers, Range: `bytes=${got}-${end}` } }, 120000, signal);
        if (r.status !== 206 && r.status !== 200) {
          const e = await r.json().catch(() => ({}));
          throw new DownloadServiceError(e.error || `HTTP ${r.status}`, { code: e.code || 'service_error' });
        }
        let buf = new Uint8Array(await r.arrayBuffer());
        if (r.status === 200 && got > 0) buf = buf.subarray(got); // server ignored Range
        if (!buf.length) throw new Error('empty chunk');
        await sink(buf);
        got += buf.length; tries = 0;
        const rate = got / Math.max(1, (Date.now() - t0) / 1000);
        if (onProgress) onProgress(70 + Math.round((got / size) * 30), { stage: 'transfer', speed: `${fmtBytes(rate)}/s`, eta: fmtEta((size - got) / rate), downloaded: got, total: size });
      } catch (e) {
        if (e.code === 'cancelled' || e.code === 'no_job') throw e;
        debugLog(`chunk at ${got} failed: ${e.message}`);
        if (++tries > 8) throw new DownloadServiceError(`The connection kept dropping (${e.message}). Tap Download again to retry.`, { code: 'network' });
        if (onStatus) onStatus(`Connection slow, retrying… (resuming at ${fmtBytes(got)})`);
        await sleep(Math.min(20000, 2000 * tries), signal);
      }
    }
    cancelJob(); // free the server copy
    return { name: j.name || `media_download.${audio ? 'mp3' : 'mp4'}`, size, mime: audio ? 'audio/mpeg' : 'video/mp4' };
  } finally {
    if (signal) signal.removeEventListener('abort', cancelJob);
  }
}

/**
 * Download a streaming-platform page (YouTube, ...) through the server's
 * yt-dlp. Returns { blob, name }.
 */
export async function fetchPlatformMedia(pageUrl, { audio = false, quality = 720, bitrate = 192, formatId = '', onProgress, onStatus, signal } = {}) {
  const base = requireApiBase();
  await wakeServer(base, onStatus);
  const parts = [];
  const r = await serverJobDownload(base, pageUrl, { audio, quality, bitrate, formatId, onProgress, onStatus, signal, sink: (c) => { parts.push(c); } });
  if (r) {
    const blob = new Blob(parts, { type: r.mime });
    if (!blob.size) throw new DownloadServiceError('The server returned an empty file.', { code: 'empty_download' });
    if (onProgress) onProgress(100);
    return { blob, name: r.name };
  }
  // Legacy single-request download (older servers).
  const url = mediaDownloadUrl(pageUrl, { audio, quality, bitrate, formatId });
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    throw new DownloadServiceError(`Could not reach the download server at ${getApiBaseUrl()} (${e.message}).`, { code: 'unreachable' });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let j = {}; try { j = JSON.parse(text); } catch (_) {}
    throw new DownloadServiceError(String(j.error || text).slice(0, 400) || `Download failed (HTTP ${res.status})`, { code: j.code || 'service_error' });
  }
  const cd = res.headers.get('content-disposition') || '';
  const m = /filename="([^"]+)"/.exec(cd);
  const name = (m && m[1]) || `media_download.${audio ? 'mp3' : 'mp4'}`;
  const blob = await res.blob();
  if (!blob || blob.size === 0) throw new DownloadServiceError('The server returned an empty file.', { code: 'empty_download' });
  if (onProgress) onProgress(100);
  return { blob, name };
}

function u8ToBase64(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Native (Capacitor): stream the job's chunks straight into a public file (no huge in-memory blob). */
const SAVE_DIRS = [
  { directory: Directory.ExternalStorage, folder: 'Download/LAS Converter', label: 'Download/LAS Converter' },
  { directory: Directory.Documents, folder: 'LAS Converter', label: 'Documents/LAS Converter' },
];
async function nativeJobDownload(pageUrl, opts) {
  const base = requireApiBase();
  await wakeServer(base, opts.onStatus);
  const { Filesystem } = capFilesystem();
  const tmpName = `las-download-${Date.now()}.part`;
  let dir = null; let n = 0;
  const sink = async (chunk) => {
    const data = u8ToBase64(chunk);
    if (!dir) {
      let lastErr;
      for (const d of SAVE_DIRS) {
        try { await Filesystem.writeFile({ path: `${d.folder}/${tmpName}`, data, directory: d.directory, recursive: true }); dir = d; break; }
        catch (e) { lastErr = e; debugLog(`cannot write to ${d.label}: ${e.message}`); }
      }
      if (!dir) throw new DownloadServiceError(`Could not save on this phone (${lastErr && lastErr.message}).`, { code: 'save_failed' });
      debugLog(`saving into ${dir.label}`);
    } else await Filesystem.appendFile({ path: `${dir.folder}/${tmpName}`, data, directory: dir.directory });
    n += chunk.length;
  };
  let r;
  try {
    r = await serverJobDownload(base, pageUrl, { quality: 720, bitrate: 192, formatId: '', ...opts, sink });
  } catch (e) {
    if (dir) Filesystem.deleteFile({ path: `${dir.folder}/${tmpName}`, directory: dir.directory }).catch(() => {});
    throw e;
  }
  if (!r) return null;
  let name = String(r.name || 'download').replace(/[\\/:*?"<>|]+/g, '_');
  try { await Filesystem.stat({ path: `${dir.folder}/${name}`, directory: dir.directory }); name = name.replace(/(\.\w+)$/, `_${Date.now()}$1`); } catch (_) { /* free name */ }
  await Filesystem.rename({ from: `${dir.folder}/${tmpName}`, directory: dir.directory, to: `${dir.folder}/${name}`, toDirectory: dir.directory });
  const uri = await Filesystem.getUri({ path: `${dir.folder}/${name}`, directory: dir.directory }).catch(() => null);
  debugLog(`saved ${dir.label}/${name} (${n} bytes)`);
  if (opts.onProgress) opts.onProgress(100);
  return { filePath: uri && uri.uri, name, bytes: r.size, location: `${dir.label}/${name}` };
}

function cleanIpcError(e) {
  let msg = String((e && e.message) || e).replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(Error:\s*)+/, '');
  let code = 'service_error';
  const m = /^\[([a-z_]+)\]\s*/.exec(msg);
  if (m) { code = m[1]; msg = msg.slice(m[0].length); }
  return new DownloadServiceError(msg, { code });
}

function electronApi() {
  return typeof window !== 'undefined' && window.electronAPI && window.electronAPI.mediaDownload ? window.electronAPI : null;
}

/** Real metadata from yt-dlp (title, duration, formats with estimated sizes). */
/**
 * Free hosted servers (Render free) sleep when idle and need ~1 minute to
 * wake. Ping /api/health first with a long timeout; report 'waking' to the UI
 * if it doesn't answer within 3 s. Remembered as awake for 10 minutes.
 */
let awakeUntil = 0;
export async function wakeServer(base, onStatus) {
  if (!/^https:\/\//i.test(base) || Date.now() < awakeUntil) return;
  const started = Date.now();
  const slow = setTimeout(() => { if (onStatus) onStatus('waking'); }, 3000);
  try {
    for (;;) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 90000);
      try {
        const r = await fetch(`${base}/api/health`, { signal: ctl.signal, cache: 'no-store' });
        if (r.ok) { awakeUntil = Date.now() + 10 * 60e3; return; }
      } catch (_) { /* still starting */ } finally { clearTimeout(t); }
      if (Date.now() - started > 150000) {
        throw new DownloadServiceError('The download server did not wake up in time. Please try again in a minute.', { code: 'unreachable' });
      }
      await new Promise((r) => setTimeout(r, 4000));
    }
  } finally {
    clearTimeout(slow);
    if (onStatus) onStatus('awake');
  }
}

export async function getMediaInfo(pageUrl, { onStatus } = {}) {
  pageUrl = validateMediaUrl(pageUrl);
  const api = electronApi();
  if (api) return api.mediaInfo(pageUrl).catch((e) => { throw cleanIpcError(e); });
  const base = requireApiBase();
  await wakeServer(base, onStatus);
  let res;
  try {
    const q = new URLSearchParams({ url: pageUrl });
    if (apiToken()) q.set('token', apiToken());
    res = await fetch(`${base}/api/media-info?${q}`);
  } catch (e) {
    throw new DownloadServiceError(`Could not reach the download server at ${base} (${e.message}).`, { code: 'unreachable' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) throw new DownloadServiceError(data.error || `Analyze failed (HTTP ${res.status})`, { code: data.code || 'service_error' });
  return data;
}

/**
 * Download a streaming-platform page and really save it.
 * Resolves { filePath?, name, bytes, location } once the file exists.
 *  - Electron: saved by the main process into the user's Downloads folder.
 *  - Android/iOS: written to Documents.
 *  - Browser: handed to the browser's download manager after it was fully fetched.
 */
export async function savePlatformMedia(pageUrl, { audio = false, quality = 720, formatId = '', onProgress, onStatus, signal } = {}) {
  pageUrl = validateMediaUrl(pageUrl);
  const api = electronApi();
  if (api) {
    const off = api.onMediaProgress((p) => {
      if (!p || p.url !== pageUrl) return;
      if (p.status && onStatus) onStatus(p.status);
      if (typeof p.percent === 'number' && onProgress) onProgress(p.percent, p);
    });
    const onAbort = () => { if (api.mediaCancel) api.mediaCancel(pageUrl).catch(() => {}); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      const r = await api.mediaDownload({ url: pageUrl, format: audio ? 'mp3' : 'mp4', quality, formatId }).catch((e) => { throw cleanIpcError(e); });
      return { ...r, location: r.filePath };
    } finally { if (off) off(); if (signal) signal.removeEventListener('abort', onAbort); }
  }
  if (isNativeApp()) {
    const r = await nativeJobDownload(pageUrl, { audio, quality, formatId, onProgress, onStatus, signal });
    if (r) return r;
  }
  const { blob, name } = await fetchPlatformMedia(pageUrl, { audio, quality, formatId, onProgress, onStatus, signal });
  if (isNativeApp()) {
    const { Filesystem, Directory } = capFilesystem();
    const saved = await Filesystem.writeFile({ path: name, data: await blobToBase64(blob), directory: Directory.Documents });
    return { filePath: saved && saved.uri, name, bytes: blob.size, location: `Documents/${name}` };
  }
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objUrl; a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { try { a.remove(); URL.revokeObjectURL(objUrl); } catch (_) {} }, 60000);
  return { name, bytes: blob.size, location: `your browser's Downloads folder (${name})` };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * Stream extraction service: the local LAS CONVERT server (`npm run serve` or
 * the desktop app), which resolves page URLs with a local yt-dlp install.
 * (The old public Cobalt instances / localhost:9000 fallbacks are gone: they
 * were offline and only produced confusing "unreachable" errors.)
 * Kept as an array for backwards compatibility with window.COBALT_API_ENDPOINTS.
 */
export const COBALT_API_ENDPOINTS = [
  `${getApiBaseUrl()}/api/extract-stream`
];

export class DownloadServiceError extends Error {
  constructor(message, { code, endpoint } = {}) {
    super(message);
    this.name = 'DownloadServiceError';
    this.code = code; // 'no_endpoints' | 'unreachable' | 'service_error' | 'invalid_url' | 'empty_download'
    this.endpoint = endpoint;
  }
}

/**
 * Triggers a real browser file save to the user's Downloads folder
 * Routes through /api/proxy-stream to bypass CORS and inject Content-Disposition: attachment
 */
export function triggerBrowserDownload(downloadUrl, fileName = 'video.mp4') {
  if (!downloadUrl) {
    throw new DownloadServiceError('Service responded but did not provide a downloadable URL.', { code: 'service_error' });
  }

  const base = getApiBaseUrl();
  const a = document.createElement('a');
  if (downloadUrl.startsWith('http')) {
    a.href = `${base}/api/proxy-stream?url=${encodeURIComponent(downloadUrl)}&filename=${encodeURIComponent(fileName)}`;
  } else {
    a.href = downloadUrl;
  }
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try { a.remove(); } catch (_) {}
  }, 1000);
}

/**
 * Attempts each configured endpoint in order until one responds successfully.
 * Distinguishes DNS/network failures (try next endpoint) from service errors.
 */
export async function resolveStreamUrl(sourceUrl, options = {}) {
  if (!COBALT_API_ENDPOINTS || COBALT_API_ENDPOINTS.length === 0) {
    throw new DownloadServiceError(
      'No download service is configured. Please specify a working endpoint in COBALT_API_ENDPOINTS.',
      { code: 'no_endpoints' }
    );
  }

  let lastError = null;

  for (const rawEndpoint of COBALT_API_ENDPOINTS) {
    const endpoint = rawEndpoint.startsWith('/') ? `${getApiBaseUrl()}${rawEndpoint}` : rawEndpoint;
    try {
      const payload = {
        url: sourceUrl,
        isAudioOnly: Boolean(options.isAudioOnly),
        vQuality: options.vQuality || '720'
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        let body = null;
        try { body = await response.json(); } catch (_) {}
        // 404 = endpoint missing (e.g. static hosting without the local server)
        if (response.status === 404) {
          console.warn(`[download] Endpoint ${endpoint} returned HTTP ${response.status}. Trying next...`);
          continue;
        }
        throw new DownloadServiceError(
          body?.text || body?.error || `Service at ${endpoint} returned HTTP ${response.status}`,
          { code: 'service_error', endpoint }
        );
      }

      const data = await response.json();
      const directUrl = data?.url || data?.stream;
      if (directUrl) {
        return directUrl;
      }
      if (data?.error) {
        throw new DownloadServiceError(data.error, { code: 'service_error', endpoint });
      }
    } catch (err) {
      if (err instanceof DownloadServiceError && err.code === 'service_error') {
        throw err;
      }
      console.warn(`[download] Endpoint unreachable: ${endpoint} (${err.message})`);
      lastError = err;
    }
  }

  throw new DownloadServiceError(
    'Could not reach the stream extraction service. Start the local server with "npm run serve" (or use the desktop app) and make sure Python + yt-dlp are installed.',
    { code: 'unreachable' }
  );
}

/**
 * Robust media downloader that works on Web, Electron, and iOS/Android Capacitor
 * Automatically resolves YouTube & stream links via extraction backend/API
 * @param {string} mediaUrl - Direct media URL or YouTube/streaming link
 * @param {string} fileName - Desired output file name
 * @param {Function} onProgress - Callback (percent)
 * @param {Object} options - Optional parameters
 * @returns {Promise<{success: boolean, url?: string}>}
 */
export async function downloadMediaURL(mediaUrl, fileName = 'video.mp4', onProgress, options = {}) {
  try {
    mediaUrl = validateMediaUrl(mediaUrl);
    const isAudio = fileName.endsWith('.mp3') || fileName.endsWith('.wav') || fileName.endsWith('.m4a');
    if (isStreamingPlatform(mediaUrl)) {
      const quality = parseInt(options.vQuality, 10) || 720;
      const r = await savePlatformMedia(mediaUrl, { audio: isAudio, quality, onProgress });
      return { success: true, ...r };
    }
    const directStreamUrl = await resolveStreamUrl(mediaUrl, { isAudioOnly: isAudio, ...options });

    if (!directStreamUrl) {
      throw new DownloadServiceError("No download link generated.", { code: 'service_error' });
    }

    // 2. Download natively with Percentage Progress
    if (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.isNativePlatform()) {
      
      // DYNAMIC IMPORTS: We load Capacitor here so the web browser doesn't crash on startup
      const CapacitorHttp = capPlugin('CapacitorHttp');
      const { Filesystem, Directory } = capFilesystem();
      
      // Listen for the download progress
      const progressListener = await CapacitorHttp.addListener('progress', (progressData) => {
        if (progressData.url === directStreamUrl && progressData.contentLength > 0) {
          const percent = Math.round((progressData.bytes / progressData.contentLength) * 100);
          if (onProgress) onProgress(percent); 
        }
      });

      // Execute the download
      const fileResponse = await CapacitorHttp.get({
        url: directStreamUrl,
        responseType: 'blob',
        progress: true
      });

      if (!fileResponse || !fileResponse.data || (typeof fileResponse.status === 'number' && fileResponse.status >= 400)) {
        progressListener.remove();
        throw new DownloadServiceError(`The media server returned no data (HTTP ${fileResponse && fileResponse.status}).`, { code: 'empty_download' });
      }

      // Save it to the phone
      await Filesystem.writeFile({
        path: fileName,
        data: fileResponse.data,
        directory: Directory.Documents
      });

      // Clean up the memory listener once finished
      progressListener.remove();
      
    } else {
      // On desktop web browser, trigger the actual file download prompt to user's Downloads folder
      triggerBrowserDownload(directStreamUrl, fileName);
      if (onProgress) onProgress(100);
    }

    return { success: true, url: directStreamUrl };
  } catch (error) {
    console.error('Download error:', error);
    throw error;
  }
}

/**
 * Download Engine for URL analysis & format remuxing
 */
export class DownloadEngine {
  async analyzeUrl(url) {
    if (!url || !/^https?:\/\//i.test(url)) {
      throw new Error('Please enter a valid URL starting with http:// or https://');
    }

    // Check if it's a YouTube or supported streaming platform link
    if (isStreamingPlatform(url)) {
      try {
        // Use noembed to extract clean metadata without CORS blocks
        const oembedRes = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`);
        if (oembedRes.ok) {
          const info = await oembedRes.json();
          if (info && info.title) {
            const cleanTitle = info.title.replace(/[/\\?%*:|"<>]/g, '-').trim();
            return {
              url,
              title: cleanTitle,
              author: info.author_name || info.provider_name || 'YouTube Video Stream',
              thumbnail: info.thumbnail_url || '',
              duration: 'HD Multi-stream Stream Ready',
              contentType: 'video/mp4 (Streaming Media)',
              formats: [
                { quality: '1080p Full HD (MP4 / H.264)', tag: '1080p' },
                { quality: '720p HD (MP4 / H.264)', tag: '720p' },
                { quality: 'Audio Only (MP3 320 kbps)', tag: 'mp3' }
              ]
            };
          }
        }
      } catch (e) {
        console.warn('OEmbed lookup note:', e.message);
      }

      // If oEmbed didn't return, return structured streaming metadata
      const parsed = new URL(url);
      const vidId = parsed.searchParams?.get('v') || parsed.pathname.split('/').pop();
      return {
        url,
        title: `YouTube Video (${vidId || 'Stream'})`,
        author: 'YouTube Stream',
        duration: 'HD Stream Ready',
        contentType: 'video/mp4 (Streaming Media)',
        formats: [
          { quality: '1080p Full HD (MP4 / H.264)', tag: '1080p' },
          { quality: '720p HD (MP4 / H.264)', tag: '720p' },
          { quality: 'Audio Only (MP3 320 kbps)', tag: 'mp3' }
        ]
      };
    }

    // For standard direct media URLs
    const parsed = new URL(url);
    let contentType = '';
    let contentLength = 0;
    try {
      const head = await fetch(url, { method: 'HEAD' });
      contentType = head.headers.get('content-type') || '';
      contentLength = parseInt(head.headers.get('content-length') || '0', 10);
    } catch (e) {
      contentType = 'unknown (CORS may block HEAD)';
    }

    const looksAudio = /audio|\.mp3|\.m4a|\.wav|\.ogg|\.flac/i.test(url + contentType);
    return {
      url,
      title: decodeURIComponent(parsed.pathname.split('/').pop() || parsed.hostname),
      author: parsed.hostname,
      duration: contentLength ? this.fmtSize(contentLength) : 'Size unknown until download',
      contentType,
      formats: looksAudio
        ? [
            { quality: 'Original audio', tag: 'orig' },
            { quality: 'MP3 192 kbps', tag: 'mp3' }
          ]
        : [
            { quality: 'Original file', tag: 'orig' },
            { quality: 'MP4', tag: 'mp4' },
            { quality: 'Audio MP3', tag: 'mp3' }
          ]
    };
  }

  fmtSize(n) {
    if (!n) return 'Unknown';
    const mb = n / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`;
  }

  async downloadStream(url, formatTag = 'orig', progressCb = () => {}) {
    // If it's a YouTube or streaming platform link, use downloadMediaURL directly
    url = validateMediaUrl(url);
    if (isStreamingPlatform(url)) {
      // Downloaded server-side by yt-dlp (+ ffmpeg merge / mp3 conversion).
      // Handing raw googlevideo URLs to the browser/proxy no longer works.
      const isAudio = formatTag === 'mp3';
      progressCb(10, 'Downloading with yt-dlp (this can take a moment)...');
      const { blob, name } = await fetchPlatformMedia(url, {
        audio: isAudio,
        quality: /^\d+p$/.test(formatTag) ? parseInt(formatTag, 10) : 720,
        onProgress: (p) => progressCb(10 + Math.round(p * 0.9), 'Downloading media...'),
      });
      progressCb(100, 'Done');
      return { blob, name, url };
    }

    // Direct file URLs
    progressCb(10, 'Fetching media...');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status}). Direct file URLs work; many sites block browser downloads.`);
    const blob = await res.blob();
    if (!blob || blob.size === 0) {
      throw new DownloadServiceError('The server returned an empty file.', { code: 'empty_download' });
    }
    progressCb(55, 'Remuxing stream...');
    const nameGuess = (url.split('?')[0].split('/').pop() || 'download.bin');
    const file = new File([blob], nameGuess, { type: blob.type || 'application/octet-stream' });
    if (formatTag === 'orig' || !window.ffmpegBridge) {
      progressCb(100, 'Done');
      return { blob, name: nameGuess };
    }
    const out = await window.ffmpegBridge.transcode(file, formatTag, {}, (p) => {
      const pct = typeof p === 'object' ? p.percent : p;
      progressCb(55 + Math.round((Number(pct) || 0) * 0.45), 'Transcoding...');
    });
    return { blob: out, name: nameGuess.replace(/\.[^/.]+$/, '') + '.' + formatTag };
  }

  async downloadMediaURL(url, fileName, onProgress, options) {
    return downloadMediaURL(url, fileName, onProgress, options);
  }
}

if (typeof window !== 'undefined') {
  window.COBALT_API_ENDPOINTS = COBALT_API_ENDPOINTS;
  window.DownloadServiceError = DownloadServiceError;
  window.resolveStreamUrl = resolveStreamUrl;
  window.setApiBaseUrl = setApiBaseUrl;
  window.builtinServer = builtinServer;
  window.fetchPlatformMedia = fetchPlatformMedia;
  window.getMediaInfo = getMediaInfo;
  window.savePlatformMedia = savePlatformMedia;
  window.lasDebugLog = debugLog;
  window.lasGetDebugLog = getDebugLog;
  window.triggerBrowserDownload = triggerBrowserDownload;
  window.isStreamingPlatform = isStreamingPlatform;
  window.isDirectFileUrl = isDirectFileUrl;
  window.validateMediaUrl = validateMediaUrl;
  window.downloadMediaURL = downloadMediaURL;
  window.DownloadEngine = DownloadEngine;
  window.downloadEngine = new DownloadEngine();
}
