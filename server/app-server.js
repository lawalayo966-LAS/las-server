// server/app-server.js
//
// LAS CONVERT local web/app server (zero-dependency HTTP server).
// Serves the web UI and the helper APIs used by it:
//   GET  /api/health
//   GET  /api/download-release?platform=windows|android|ios
//   GET  /downloads/<artifact>          -> real build outputs (exe / apk) if built
//   POST /api/extract-stream            -> resolve a media page URL with local yt-dlp
//   GET  /api/media-download?url=&format=mp4|mp3 -> yt-dlp download + ffmpeg merge/mp3
//   GET  /api/proxy-stream?url=&filename= -> SSRF-guarded download proxy
//   POST /api/convert-large-video       -> native ffmpeg audio extraction
//
// Used by `npm run serve` (build-scripts/dev-server.js) and by the Electron
// main process. Binds to 127.0.0.1 by default (override with LAS_HOST).

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { FFMPEG_PATH } = require('./binaries');
const {
  applyCors,
  assertPublicHttpUrl,
  getBindHost,
  isInside,
  safeDownloadName,
  SsrfError,
} = require('./security');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_PROXY_REDIRECTS = 5;

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.mjs': 'text/javascript',
  '.apk': 'application/vnd.android.package-archive',
  '.exe': 'application/x-msdownload',
  '.zip': 'application/zip',
  '.7z': 'application/x-7z-compressed',
};

const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// ----------------------------------------------------------------- helpers

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_JSON_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// ------------------------------------------------- downloadable app builds

/**
 * Canonical public names for the app installers, mapped to the places the
 * real build tools write them. The first existing file wins.
 */
// ----------------------------------------------------- yt-dlp extraction

const ytdlp = require('./ytdlp');

/** Kept for backwards compatibility (python fallback list). */
function pythonCandidates() {
  const configured = process.env.LAS_PYTHON || process.env.PYTHON;
  const list = configured ? [configured] : [];
  for (const c of ['python3', 'python', 'py']) if (!list.includes(c)) list.push(c);
  return list;
}

async function handleExtractStream(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { success: false, status: 'error', error: e.message });
  }
  const targetUrl = typeof payload.url === 'string' ? payload.url.trim() : '';
  if (!targetUrl) {
    return sendJson(res, 400, { success: false, status: 'error', error: 'Please enter a media URL.' });
  }
  try {
    // Validates scheme (http/https only) and refuses private / loopback hosts.
    await assertPublicHttpUrl(targetUrl);
  } catch (e) {
    return sendJson(res, 400, { success: false, status: 'error', error: e.message });
  }

  const args = ['--no-playlist', '-g'];
  if (payload.isAudioOnly) {
    args.push('-f', 'bestaudio/best');
  } else {
    const q = parseInt(payload.vQuality, 10);
    if (q > 0 && q <= 4320) args.push('-f', `best[height<=${q}][ext=mp4]/best[height<=${q}]/best`);
  }
  args.push('--', targetUrl); // "--" stops yt-dlp from treating the URL as an option

  try {
    const { code, out, err } = await ytdlp.runYtDlp(args);
    const lines = out.trim().split(/\r?\n/).filter((l) => /^https?:\/\//i.test(l));
    if (code === 0 && lines.length > 0) {
      return sendJson(res, 200, { success: true, status: 'stream', url: lines[0] });
    }
    const reason = ytdlp.lastErrorLine(err, code);
    return sendJson(res, 422, { success: false, status: 'error', error: `Could not extract media stream: ${reason}` });
  } catch (e) {
    return sendJson(res, 503, { success: false, status: 'error', error: e.message });
  }
}

// ------------------------------------------- media info (yt-dlp -J)

async function handleMediaInfo(req, res, urlObj) {
  const targetUrl = (urlObj.searchParams.get('url') || '').trim();
  if (!targetUrl) return sendJson(res, 400, { success: false, error: 'Please enter a media URL.' });
  try {
    await assertPublicHttpUrl(targetUrl);
  } catch (e) {
    return sendJson(res, 400, { success: false, error: e.message });
  }
  try {
    return sendJson(res, 200, { success: true, ...(await ytdlp.getInfo(targetUrl)) });
  } catch (e) {
    return sendJson(res, 422, { success: false, code: e.code, error: e.message });
  }
}

// ------------------------------------------- full media download (yt-dlp)

/**
 * GET /api/media-download?url=&format=mp4|mp3&quality=720&bitrate=192
 * Downloads the page URL server-side with yt-dlp (+ffmpeg merge / mp3
 * conversion) and streams the finished file back as an attachment. This is
 * the reliable path for YouTube: googlevideo stream URLs are bound to the
 * extracting client and are split into separate video/audio streams, so
 * handing them to a browser / proxy (the old -g approach) fails.
 */
const activeMediaDownloads = { n: 0, max: parseInt(process.env.LAS_MAX_MEDIA_DOWNLOADS || '3', 10) };
async function handleMediaDownload(req, res, urlObj) {
  req.setTimeout(0);
  res.setTimeout(0);
  const targetUrl = (urlObj.searchParams.get('url') || '').trim();
  const format = (urlObj.searchParams.get('format') || 'mp4').toLowerCase();
  if (!targetUrl) return sendJson(res, 400, { success: false, error: 'Please enter a media URL.' });
  if (format !== 'mp4' && format !== 'mp3') return sendJson(res, 400, { success: false, error: 'format must be mp4 or mp3' });
  const quality = parseInt(urlObj.searchParams.get('quality') || '720', 10);
  const bitrate = Math.max(64, Math.min(320, parseInt(urlObj.searchParams.get('bitrate') || '192', 10) || 192));
  try {
    await assertPublicHttpUrl(targetUrl);
  } catch (e) {
    return sendJson(res, 400, { success: false, error: e.message });
  }
  if (activeMediaDownloads.n >= activeMediaDownloads.max) {
    return sendJson(res, 429, { success: false, error: 'Too many downloads in progress, try again shortly.' });
  }
  activeMediaDownloads.n++;
  let result;
  try {
    const formatId = (urlObj.searchParams.get('formatId') || '').trim();
    result = await ytdlp.downloadMedia(targetUrl, { kind: format === 'mp3' ? 'audio' : 'video', quality, bitrate, formatId });
  } catch (e) {
    activeMediaDownloads.n--;
    return sendJson(res, 422, { success: false, code: e.code, error: e.message });
  }
  activeMediaDownloads.n--;
  const cleanup = () => fs.rm(result.dir, { recursive: true, force: true }, () => {});
  const name = safeDownloadName(`${result.title}.${result.ext}`, `media_download.${format}`);
  const stat = fs.statSync(result.file);
  res.writeHead(200, {
    'Content-Type': result.ext === 'mp3' ? 'audio/mpeg' : result.ext === 'mp4' ? 'video/mp4' : 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${name}"`,
    'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length',
  });
  const stream = fs.createReadStream(result.file);
  stream.pipe(res);
  stream.on('close', cleanup);
  res.on('close', () => { stream.destroy(); cleanup(); });
}

// ------------------------------------------------------- download proxy

/**
 * GET an external URL with SSRF protection. Every hop (including redirects)
 * is validated, and the socket is pinned to the validated IP address so a
 * DNS answer cannot change between the check and the connection.
 */
async function guardedGet(rawUrl, redirectsLeft = MAX_PROXY_REDIRECTS) {
  const { url, address, family } = await assertPublicHttpUrl(rawUrl);
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(url, {
      headers: { 'User-Agent': 'LAS-CONVERT/1.0', Accept: '*/*' },
      timeout: 20000,
      lookup: (_host, opts, cb) => {
        if (opts && opts.all) cb(null, [{ address, family }]);
        else cb(null, address, family);
      },
    }, (upstream) => {
      const status = upstream.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && upstream.headers.location) {
        upstream.resume();
        if (redirectsLeft <= 0) return reject(new SsrfError('Too many redirects'));
        let next;
        try {
          next = new URL(upstream.headers.location, url).toString();
        } catch (e) {
          return reject(new SsrfError('Invalid redirect'));
        }
        guardedGet(next, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      resolve(upstream);
    });
    req.on('timeout', () => req.destroy(new Error('Upstream timed out')));
    req.on('error', reject);
  });
}

async function handleProxyStream(req, res, urlObj) {
  const targetUrl = urlObj.searchParams.get('url');
  if (!targetUrl) return sendText(res, 400, 'Missing url parameter');
  const filename = safeDownloadName(urlObj.searchParams.get('filename') || 'media_download.mp4', 'media_download.mp4');

  let upstream;
  try {
    upstream = await guardedGet(targetUrl);
  } catch (e) {
    return sendText(res, e instanceof SsrfError ? 403 : 502, `Proxy error: ${e.message}`);
  }
  const status = upstream.statusCode || 502;
  if (status < 200 || status >= 300) {
    upstream.resume();
    return sendText(res, 502, `Upstream returned HTTP ${status}`);
  }
  const headers = {
    'Content-Type': upstream.headers['content-type'] || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (upstream.headers['content-length']) headers['Content-Length'] = upstream.headers['content-length'];
  res.writeHead(200, headers);
  upstream.pipe(res);
  upstream.on('error', () => res.destroy());
  res.on('close', () => upstream.destroy());
}

// ------------------------------------------- native large-video -> audio

const LARGE_AUDIO_FORMATS = {
  mp3: { codec: 'libmp3lame', mime: 'audio/mpeg', bitrate: true },
  wav: { codec: 'pcm_s16le', mime: 'audio/wav', bitrate: false },
  m4a: { codec: 'aac', mime: 'audio/mp4', bitrate: true },
  aac: { codec: 'aac', mime: 'audio/aac', bitrate: true },
  flac: { codec: 'flac', mime: 'audio/flac', bitrate: false },
  ogg: { codec: 'libvorbis', mime: 'audio/ogg', bitrate: true },
  opus: { codec: 'libopus', mime: 'audio/ogg', bitrate: true },
};

function handleConvertLargeVideo(req, res, urlObj) {
  req.setTimeout(0);
  res.setTimeout(0);

  const fmt = (urlObj.searchParams.get('format') || 'mp3').toLowerCase();
  const spec = LARGE_AUDIO_FORMATS[fmt];
  if (!spec) return sendJson(res, 400, { error: `Unsupported audio format: ${fmt}` });
  const kbps = parseInt(String(urlObj.searchParams.get('bitrate') || '192').replace(/k$/i, ''), 10);
  if (!Number.isInteger(kbps) || kbps < 32 || kbps > 512) return sendJson(res, 400, { error: 'Invalid bitrate' });

  const tempId = `las_${crypto.randomUUID()}`;
  const tempIn = path.join(os.tmpdir(), `${tempId}_input.bin`);
  const tempOut = path.join(os.tmpdir(), `${tempId}_output.${fmt}`);
  const cleanup = () => {
    fs.rm(tempIn, { force: true }, () => {});
    fs.rm(tempOut, { force: true }, () => {});
  };

  const writeStream = fs.createWriteStream(tempIn, { flags: 'wx' });
  req.pipe(writeStream);

  writeStream.on('finish', () => {
    const args = ['-y', '-i', tempIn, '-vn', '-c:a', spec.codec];
    if (spec.codec === 'libvorbis') args.push('-q:a', String(Math.max(0, Math.min(10, Math.round(kbps / 32)))));
    else if (spec.bitrate) args.push('-b:a', `${kbps}k`);
    args.push(tempOut);
    const proc = spawn(FFMPEG_PATH, args, { windowsHide: true });
    proc.on('close', (code) => {
      fs.rm(tempIn, { force: true }, () => {});
      if (code !== 0 || !fs.existsSync(tempOut)) {
        cleanup();
        return sendJson(res, 500, { error: `Native conversion failed with code ${code}` });
      }
      const stat = fs.statSync(tempOut);
      res.writeHead(200, {
        'Content-Type': spec.mime,
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="converted_audio.${fmt}"`,
        ...ISOLATION_HEADERS,
      });
      const rs = fs.createReadStream(tempOut);
      rs.pipe(res);
      rs.on('close', cleanup);
    });
    proc.on('error', (err) => {
      cleanup();
      sendJson(res, 500, { error: `Could not run ffmpeg: ${err.message}` });
    });
  });
  writeStream.on('error', (err) => {
    cleanup();
    sendJson(res, 500, { error: err.message });
  });
}

// ---------------------------------------------------------- static files

const DENIED_PREFIXES = ['server/tmp_uploads', 'server/tmp_outputs'];

function resolveStaticPath(reqPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(reqPath);
  } catch (e) {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = decoded.replace(/^\/+/, '');
  const segments = rel.split(/[\\/]/);
  if (segments.some((s) => s.startsWith('.'))) return null; // dotfiles, .git, .env, ..
  if (DENIED_PREFIXES.some((p) => rel === p || rel.startsWith(`${p}/`))) return null;
  const filePath = path.resolve(ROOT_DIR, rel);
  if (!isInside(ROOT_DIR, filePath)) return null;
  return filePath;
}

function serveStatic(req, res, reqPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method Not Allowed');
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = resolveStaticPath(reqPath);
  if (!filePath) return sendText(res, 404, '404 Not Found');

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) return sendText(res, 404, '404 Not Found');
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': stats.size,
      ...ISOLATION_HEADERS,
    };
    if (ext === '.apk' || ext === '.exe') {
      headers['Content-Disposition'] = `attachment; filename="${path.basename(filePath)}"`;
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

// ---------------------------------------------------------------- server

function createAppServer() {
  return http.createServer(async (req, res) => {
    try {
      if (!applyCors(req, res, { methods: 'GET, POST, OPTIONS' })) return;
      const urlObj = new URL(req.url, 'http://localhost');
      const reqPath = urlObj.pathname;

      if (reqPath === '/api/health') return sendJson(res, 200, { ok: true, service: 'app-server' });


      if (reqPath === '/api/extract-stream' && req.method === 'POST') return await handleExtractStream(req, res);
      if (reqPath === '/api/media-info' && req.method === 'GET') return await handleMediaInfo(req, res, urlObj);
      if (reqPath === '/api/media-download' && req.method === 'GET') return await handleMediaDownload(req, res, urlObj);
      if (reqPath === '/api/proxy-stream' && req.method === 'GET') return await handleProxyStream(req, res, urlObj);
      if (reqPath === '/api/convert-large-video' && req.method === 'POST') return handleConvertLargeVideo(req, res, urlObj);

      return serveStatic(req, res, reqPath);
    } catch (err) {
      console.error('[APP-SERVER] Unexpected error:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
      else res.destroy();
    }
  });
}

/**
 * Start the app server (and, by default, the native conversion server).
 * Resolves with { server, host, port, convert, close }.
 */
async function startAppServer({ port = DEFAULT_PORT, host = getBindHost(), startConvert = true, convertOptions = {} } = {}) {
  const server = createAppServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const actualPort = server.address().port;
  console.log(`[APP-SERVER] LAS CONVERT running at http://${host === '127.0.0.1' ? 'localhost' : host}:${actualPort}`);
  console.log(`[APP-SERVER] Native FFmpeg: ${FFMPEG_PATH}`);

  let convert = null;
  if (startConvert) {
    try {
      const { startConvertServer } = require('./convert-server');
      convert = await startConvertServer({ host, ...convertOptions });
    } catch (err) {
      console.warn(`[APP-SERVER] Could not start convert-server: ${err.message}`);
    }
  }

  return {
    server,
    host,
    port: actualPort,
    convert,
    close: async () => {
      if (convert) await convert.close();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

module.exports = { createAppServer, startAppServer, guardedGet, resolveStaticPath, pythonCandidates };
