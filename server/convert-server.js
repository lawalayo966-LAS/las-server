// server/convert-server.js
//
// Local streaming conversion server for LAS Convert.
// Runs native ffmpeg (not ffmpeg.wasm) so there is no ~2GB WebAssembly
// memory ceiling. Handles uploads as streams (never buffers the whole
// file in memory) and reports live progress over WebSocket.
//
// Security model:
//   * Binds to 127.0.0.1 by default (override with LAS_HOST).
//   * Only localhost origins may call it (CORS + Origin/Host checks).
//   * Every job gets a server-generated UUID; all on-disk paths are generated
//     by the server and checked to stay inside the uploads/outputs dirs.
//     Client-supplied file names are only used (sanitised) as display names.
//   * No raw ffmpeg argument passthrough: formats, codecs and numeric options
//     are validated against allowlists and passed to spawn() as an arg array.

const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getMediaSummary, MediaValidationError } = require('./validate-media');
const { zipFiles, zipDirectory, unzipFile, isValidZip } = require('./archive-engine');
const { FFMPEG_PATH } = require('./binaries');
const {
  applyCors,
  getBindHost,
  isAllowedOrigin,
  isAllowedHostHeader,
  isInside,
  isValidJobId,
  safeDownloadName,
} = require('./security');

const DEFAULT_PORT = parseInt(process.env.CONVERT_SERVER_PORT || '4501', 10);
const MAX_JSON_BODY_BYTES = 64 * 1024;
const JOB_TTL_MS = parseInt(process.env.LAS_JOB_TTL_MS || String(2 * 60 * 60 * 1000), 10);
const MAX_UPLOAD_BYTES = parseInt(process.env.LAS_MAX_UPLOAD_BYTES || '0', 10); // 0 = unlimited

const AUDIO_FORMATS = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus'];
const VIDEO_FORMATS = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'gif', 'flv', 'wmv', 'm4v'];
const VIDEO_CODECS = new Set(['libx264', 'libx265', 'libvpx', 'libvpx-vp9', 'libaom-av1', 'mpeg4', 'copy']);
const AUDIO_CODECS = new Set(['aac', 'libmp3lame', 'libopus', 'libvorbis', 'flac', 'pcm_s16le', 'alac', 'copy']);
const DEFAULT_AUDIO_CODEC = {
  mp3: 'libmp3lame', wav: 'pcm_s16le', flac: 'flac', aac: 'aac', m4a: 'aac', ogg: 'libvorbis', opus: 'libopus',
};
const COMPRESS_MODES = new Set(['auto', 'force-zip', 'force-media', 'force-rezip']);

class RequestError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/**
 * Build the ffmpeg argument array for /api/convert from validated options.
 * Throws RequestError(400) for anything outside the allowlists.
 */
function buildConvertArgs({ inputPath, outputPath, outputFormat, videoCodec, audioCodec, crf, audioBitrate, extraArgs }) {
  if (Array.isArray(extraArgs) ? extraArgs.length > 0 : extraArgs != null && extraArgs !== '') {
    throw new RequestError(400, 'extraArgs is not supported. Use outputFormat/videoCodec/audioCodec/crf/audioBitrate.');
  }
  const fmt = String(outputFormat || 'mp4').toLowerCase();
  const isAudioTarget = AUDIO_FORMATS.includes(fmt);
  if (!isAudioTarget && !VIDEO_FORMATS.includes(fmt)) {
    throw new RequestError(400, `Unsupported output format: ${fmt}`);
  }
  if (videoCodec != null && !VIDEO_CODECS.has(videoCodec)) {
    throw new RequestError(400, `Unsupported video codec: ${videoCodec}`);
  }
  if (audioCodec != null && !AUDIO_CODECS.has(audioCodec)) {
    throw new RequestError(400, `Unsupported audio codec: ${audioCodec}`);
  }
  let crfValue = null;
  if (crf != null && crf !== '') {
    crfValue = Number(crf);
    if (!Number.isInteger(crfValue) || crfValue < 0 || crfValue > 63) {
      throw new RequestError(400, 'crf must be an integer between 0 and 63');
    }
  }
  let bitrate = null;
  if (audioBitrate != null && audioBitrate !== '') {
    const m = String(audioBitrate).match(/^(\d{2,3})k?$/i);
    if (!m || Number(m[1]) < 32 || Number(m[1]) > 512) {
      throw new RequestError(400, 'audioBitrate must be between 32k and 512k');
    }
    bitrate = `${m[1]}k`;
  }

  const args = ['-y', '-i', inputPath];
  if (isAudioTarget) {
    const codec = audioCodec || DEFAULT_AUDIO_CODEC[fmt];
    args.push('-vn', '-c:a', codec);
    if (codec === 'libvorbis') {
      // libvorbis rejects many -b:a values (e.g. for low sample rates); use VBR quality instead.
      args.push('-q:a', String(bitrate ? Math.max(0, Math.min(10, Math.round(parseInt(bitrate, 10) / 32))) : 5));
    } else if (bitrate && !['wav', 'flac'].includes(fmt)) {
      args.push('-b:a', bitrate);
    }
  } else if (fmt === 'gif') {
    args.push('-vf', 'fps=10,scale=480:-1:flags=lanczos', '-loop', '0');
  } else {
    if (videoCodec) args.push('-c:v', videoCodec);
    if (audioCodec) args.push('-c:a', audioCodec);
    if (crfValue != null && videoCodec !== 'copy') args.push('-crf', String(crfValue));
    if (bitrate && audioCodec !== 'copy') args.push('-b:a', bitrate);
  }
  args.push('-progress', 'pipe:1', '-nostats', outputPath);
  return { args, fmt, isAudioTarget };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        reject(new RequestError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const parsed = JSON.parse(text || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        resolve(parsed);
      } catch (e) {
        reject(new RequestError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function rmQuiet(target) {
  if (!target) return;
  fs.rm(target, { recursive: true, force: true }, () => {});
}

function createConvertServer({ workDir } = {}) {
  const baseDir = path.resolve(workDir || process.env.LAS_WORK_DIR || __dirname);
  const UPLOAD_DIR = path.join(baseDir, 'tmp_uploads');
  const OUTPUT_DIR = path.join(baseDir, 'tmp_outputs');
  for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) fs.mkdirSync(dir, { recursive: true });

  /** jobId -> { id, displayName, declaredSize, uploadPath, state, outputPath, outputFile, extractDir, createdAt } */
  const jobs = new Map();
  /** jobId -> Set of open sockets listening for progress on that job */
  const jobSockets = new Map();

  function broadcastProgress(jobId, payload) {
    const sockets = jobSockets.get(jobId);
    if (!sockets) return;
    const msg = JSON.stringify(payload);
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  }

  function destroyJob(job) {
    if (!job) return;
    rmQuiet(job.uploadPath);
    rmQuiet(job.outputPath);
    rmQuiet(job.extractDir);
    jobs.delete(job.id);
  }

  // Periodically purge abandoned jobs and their files.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const job of jobs.values()) {
      if (now - job.createdAt > JOB_TTL_MS && job.state !== 'processing') destroyJob(job);
    }
  }, Math.min(JOB_TTL_MS, 10 * 60 * 1000));
  sweeper.unref();

  /** Look up a job by id and require it to be in one of the given states. */
  function requireJob(jobId, states) {
    if (!isValidJobId(jobId)) throw new RequestError(400, 'Invalid jobId');
    const job = jobs.get(jobId);
    if (!job) throw new RequestError(404, 'Unknown job');
    if (states && !states.includes(job.state)) {
      throw new RequestError(409, `Job is ${job.state}`);
    }
    if (!isInside(UPLOAD_DIR, job.uploadPath)) throw new RequestError(500, 'Internal path error');
    return job;
  }

  function finishJob(job, outputPath, friendlyName, extra = {}) {
    if (!isInside(OUTPUT_DIR, outputPath)) {
      job.state = 'error';
      broadcastProgress(job.id, { phase: 'error', message: 'Internal path error' });
      return;
    }
    job.state = 'done';
    job.outputPath = job.outputPath || outputPath;
    job.downloadPath = outputPath;
    job.outputFile = `${job.id}__${safeDownloadName(friendlyName, 'output.bin').replace(/ /g, '_')}`;
    rmQuiet(job.uploadPath);
    broadcastProgress(job.id, { phase: 'done', percent: 100, outputFile: job.outputFile, ...extra });
  }

  function failJob(job, message) {
    job.state = 'error';
    rmQuiet(job.uploadPath);
    rmQuiet(job.outputPath);
    broadcastProgress(job.id, { phase: 'error', message });
  }

  function runFfmpeg(job, args, durationSeconds, engineTag, onDone) {
    console.log(`[CONVERT-SERVER] Job ${job.id}: ${FFMPEG_PATH} ${args.join(' ')}`);
    const ff = spawn(FFMPEG_PATH, args, { windowsHide: true });

    let stderrTail = '';
    ff.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });

    let stdoutBuf = '';
    ff.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();
      for (const line of lines) {
        const [key, value] = line.split('=');
        if (key === 'out_time_ms' && durationSeconds > 0) {
          const processedSeconds = parseInt(value, 10) / 1_000_000;
          const percent = Math.min(99, Math.round((processedSeconds / durationSeconds) * 100));
          broadcastProgress(job.id, { phase: 'converting', percent, ...(engineTag ? { engine: engineTag } : {}) });
        }
        if (key === 'progress' && value === 'end') {
          broadcastProgress(job.id, { phase: 'converting', percent: 100, ...(engineTag ? { engine: engineTag } : {}) });
        }
      }
    });

    let settled = false;
    ff.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) onDone();
      else failJob(job, `ffmpeg exited with code ${code}: ${stderrTail.trim().split('\n').slice(-3).join(' ')}`);
    });
    ff.on('error', (err) => {
      if (settled) return;
      settled = true;
      failJob(job, `Could not run ffmpeg: ${err.message}`);
    });
  }

  async function probeOrReject(job) {
    try {
      return await getMediaSummary(job.uploadPath);
    } catch (valErr) {
      const errorMsg = valErr instanceof MediaValidationError
        ? `This doesn't look like a valid video, audio, or image file. (${valErr.message})`
        : `Media validation error: ${valErr.message}`;
      console.warn(`[CONVERT-SERVER] Rejected non-media upload (${job.id}): ${errorMsg}`);
      failJob(job, errorMsg);
      throw new RequestError(422, errorMsg, { error: 'not_media' });
    }
  }

  function startZipJob(job, phaseTag) {
    const friendly = `${job.displayName}.zip`;
    const outputPath = path.join(OUTPUT_DIR, `${job.id}.zip`);
    job.state = 'processing';
    job.outputPath = outputPath;
    broadcastProgress(job.id, { phase: 'zipping', percent: 0, engine: 'zip' });
    zipFiles([{ path: job.uploadPath, name: safeDownloadName(job.displayName) }], outputPath, (percent) => {
      broadcastProgress(job.id, { phase: 'zipping', percent, engine: 'zip' });
    })
      .then((result) => finishJob(job, outputPath, friendly, {
        engine: 'zip',
        originalSize: result.originalSize,
        compressedSize: result.compressedSize,
      }))
      .catch((err) => failJob(job, `${phaseTag}: ${err.message}`));
    return path.basename(outputPath);
  }

  // ------------------------------------------------------------------ routes

  async function handleUploadStart(req, res) {
    const { fileName, fileSize } = await readJsonBody(req);
    const size = Number(fileSize);
    if (!fileName || !Number.isFinite(size) || size <= 0) {
      throw new RequestError(400, 'fileName and a positive fileSize are required');
    }
    if (MAX_UPLOAD_BYTES > 0 && size > MAX_UPLOAD_BYTES) {
      throw new RequestError(413, `File exceeds the configured upload limit (${MAX_UPLOAD_BYTES} bytes)`);
    }
    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      displayName: safeDownloadName(path.basename(String(fileName).replace(/\\/g, '/')), 'upload.bin'),
      declaredSize: size,
      uploadPath: path.join(UPLOAD_DIR, `${jobId}.upload`),
      state: 'created',
      createdAt: Date.now(),
    };
    jobs.set(jobId, job);
    sendJson(res, 200, { jobId, uploadUrl: `/api/upload/${jobId}` });
  }

  function handleUploadPut(req, res, jobId) {
    const job = requireJob(jobId, ['created']);
    job.state = 'uploading';
    req.setTimeout(0);
    res.setTimeout(0);

    const writeStream = fs.createWriteStream(job.uploadPath, { flags: 'wx' });
    let bytesReceived = 0;
    let aborted = false;

    const abort = (status, message) => {
      if (aborted) return;
      aborted = true;
      req.unpipe(writeStream);
      writeStream.destroy();
      rmQuiet(job.uploadPath);
      job.state = 'error';
      broadcastProgress(job.id, { phase: 'error', message });
      sendJson(res, status, { error: message });
      req.resume();
    };

    req.on('data', (chunk) => {
      bytesReceived += chunk.length;
      if (bytesReceived > job.declaredSize) {
        abort(413, 'Upload is larger than the declared fileSize');
        return;
      }
      broadcastProgress(job.id, {
        phase: 'uploading',
        percent: Math.min(99, Math.round((bytesReceived / job.declaredSize) * 100)),
      });
    });

    req.pipe(writeStream);

    writeStream.on('finish', () => {
      if (aborted) return;
      job.state = 'uploaded';
      broadcastProgress(job.id, { phase: 'uploading', percent: 100 });
      sendJson(res, 200, { ok: true, jobId: job.id, bytes: bytesReceived });
    });
    writeStream.on('error', (err) => abort(500, `Upload write failed: ${err.message}`));
    req.on('error', (err) => abort(400, `Upload stream error: ${err.message}`));
  }

  async function handleConvert(req, res) {
    const payload = await readJsonBody(req);
    const job = requireJob(payload.jobId, ['uploaded']);

    // Validate options BEFORE touching the upload so bad requests are cheap.
    const outputPathFor = (fmt) => path.join(OUTPUT_DIR, `${job.id}.${fmt}`);
    const { fmt } = buildConvertArgs({ ...payload, inputPath: job.uploadPath, outputPath: outputPathFor('tmp') });
    const outputPath = outputPathFor(fmt);
    const { args } = buildConvertArgs({ ...payload, inputPath: job.uploadPath, outputPath });

    job.state = 'processing';
    const mediaInfo = await probeOrReject(job);
    job.outputPath = outputPath;
    const friendly = `${job.displayName.replace(/\.[^.]+$/, '')}_converted.${fmt}`;
    runFfmpeg(job, args, mediaInfo.durationSeconds || 0, null, () => finishJob(job, outputPath, friendly));
    sendJson(res, 200, { ok: true, jobId: job.id });
  }

  async function handleCompress(req, res) {
    const { jobId, mode = 'auto', ratioPercent = 75 } = await readJsonBody(req);
    if (!COMPRESS_MODES.has(mode)) throw new RequestError(400, 'Invalid mode');
    const job = requireJob(jobId, ['uploaded']);

    let mediaInfo = null;
    let useZip = mode === 'force-zip';
    if (!useZip) {
      try {
        mediaInfo = await getMediaSummary(job.uploadPath);
      } catch (err) {
        if (!(err instanceof MediaValidationError)) {
          failJob(job, err.message);
          throw new RequestError(500, err.message);
        }
        if (mode === 'force-media') {
          failJob(job, err.message);
          throw new RequestError(422, err.message, { error: 'not_media' });
        }
        useZip = true; // Auto-fallback: treat non-media (e.g. .exe) as ZIP archive
      }
    }

    if (useZip && mode !== 'force-rezip' && isValidZip(job.uploadPath)) {
      // Leave the job in "uploaded" state so the client can call /api/archive/unzip.
      throw new RequestError(409, 'This file is already a ZIP archive. Use extract instead of compress.', {
        error: 'already_zip',
        suggestedEndpoint: '/api/archive/unzip',
      });
    }

    if (useZip) {
      startZipJob(job, 'Archive compression failed');
      sendJson(res, 200, { ok: true, jobId: job.id, routedTo: 'zip' });
      return;
    }

    const isAudio = mediaInfo.type === 'audio';
    const ext = isAudio ? 'mp3' : 'mp4';
    const outputPath = path.join(OUTPUT_DIR, `${job.id}.${ext}`);
    const ratio = Math.min(90, Math.max(10, parseInt(ratioPercent, 10) || 50));
    const crf = String(Math.round(20 + (ratio / 90) * 16)); // 20 to 36 CRF
    const audioBr = ratio > 60 ? '64k' : '128k';
    const args = [
      '-y',
      '-i', job.uploadPath,
      ...(isAudio ? ['-vn', '-c:a', 'libmp3lame', '-b:a', audioBr] : ['-c:v', 'libx264', '-crf', crf, '-c:a', 'aac', '-b:a', audioBr]),
      '-progress', 'pipe:1',
      '-nostats',
      outputPath,
    ];
    job.state = 'processing';
    job.outputPath = outputPath;
    const friendly = `${job.displayName.replace(/\.[^.]+$/, '')}_compressed.${ext}`;
    runFfmpeg(job, args, mediaInfo.durationSeconds || 0, 'media', () => finishJob(job, outputPath, friendly, { engine: 'media' }));
    sendJson(res, 200, { ok: true, jobId: job.id, routedTo: 'media' });
  }

  async function handleArchiveZip(req, res) {
    const { jobId } = await readJsonBody(req);
    const job = requireJob(jobId, ['uploaded']);
    startZipJob(job, 'Zip failed');
    sendJson(res, 200, { ok: true, jobId: job.id });
  }

  async function handleArchiveUnzip(req, res) {
    const { jobId } = await readJsonBody(req);
    const job = requireJob(jobId, ['uploaded']);
    if (!isValidZip(job.uploadPath)) {
      failJob(job, 'This file is not a valid ZIP archive.');
      throw new RequestError(422, 'This file is not a valid ZIP archive.', { error: 'not_zip' });
    }

    const extractDir = path.join(OUTPUT_DIR, `${job.id}_extracted`);
    job.state = 'processing';
    job.extractDir = extractDir;
    sendJson(res, 200, { ok: true, jobId: job.id, extracting: true });

    try {
      const result = await unzipFile(job.uploadPath, extractDir, (percent) => {
        broadcastProgress(job.id, { phase: 'extracting', percent });
      });

      if (result.extractedFiles.length === 1) {
        const single = path.resolve(extractDir, result.extractedFiles[0]);
        if (!isInside(extractDir, single)) throw new Error('Unsafe extracted path');
        job.outputPath = null;
        finishJob(job, single, path.basename(single), { isDirectory: false });
      } else {
        const repackedZipPath = path.join(OUTPUT_DIR, `${job.id}_extracted.zip`);
        job.outputPath = repackedZipPath;
        await zipDirectory(extractDir, repackedZipPath, (percent) => {
          broadcastProgress(job.id, { phase: 'repacking', percent });
        });
        rmQuiet(extractDir);
        job.extractDir = null;
        finishJob(job, repackedZipPath, `${job.displayName.replace(/\.zip$/i, '')}_extracted.zip`, {
          extractedFileCount: result.extractedFiles.length,
        });
      }
    } catch (err) {
      rmQuiet(extractDir);
      failJob(job, `Unzip failed: ${err.message}`);
    }
  }

  function handleDownload(req, res, requested) {
    const jobId = requested.slice(0, 36);
    if (!isValidJobId(jobId)) throw new RequestError(404, 'Output not found');
    const job = jobs.get(jobId);
    if (!job || job.state !== 'done' || job.outputFile !== requested || !job.downloadPath) {
      throw new RequestError(404, 'Output not found');
    }
    if (!isInside(OUTPUT_DIR, job.downloadPath) || !fs.existsSync(job.downloadPath)) {
      throw new RequestError(404, 'Output not found');
    }

    const stat = fs.statSync(job.downloadPath);
    const downloadName = job.outputFile.slice(38) || 'output.bin';
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${downloadName}"`,
    });
    const stream = fs.createReadStream(job.downloadPath);
    stream.pipe(res);
    stream.on('close', () => {
      setTimeout(() => destroyJob(job), 60000).unref();
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!applyCors(req, res)) return;

      const pathname = new URL(req.url, 'http://localhost').pathname;

      if (pathname === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, service: 'convert-server' });
      }
      if (pathname === '/api/upload/start' && req.method === 'POST') return await handleUploadStart(req, res);
      if (pathname.startsWith('/api/upload/') && req.method === 'PUT') {
        // /api/upload/<jobId>[/<ignored display name>]
        const jobId = pathname.slice('/api/upload/'.length).split('/')[0];
        return handleUploadPut(req, res, jobId);
      }
      if (pathname === '/api/convert' && req.method === 'POST') return await handleConvert(req, res);
      if (pathname === '/api/compress' && req.method === 'POST') return await handleCompress(req, res);
      if (pathname === '/api/archive/zip' && req.method === 'POST') return await handleArchiveZip(req, res);
      if (pathname === '/api/archive/unzip' && req.method === 'POST') return await handleArchiveUnzip(req, res);
      if (pathname.startsWith('/api/download/') && req.method === 'GET') {
        let requested;
        try {
          requested = decodeURIComponent(pathname.slice('/api/download/'.length));
        } catch (e) {
          throw new RequestError(400, 'Bad download name');
        }
        return handleDownload(req, res, requested);
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } catch (err) {
      if (err instanceof RequestError) {
        return sendJson(res, err.status, { error: err.extra.error || err.message, message: err.message, ...err.extra });
      }
      console.error('[CONVERT-SERVER] Unexpected error:', err);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  });

  // WebSocket Server for progress tracking (same origin restrictions as HTTP)
  const wss = new WebSocketServer({
    server,
    path: '/progress',
    verifyClient: ({ origin, req }) =>
      isAllowedHostHeader(req.headers.host) && (!origin || isAllowedOrigin(origin)),
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const jobId = url.searchParams.get('jobId');
    if (!isValidJobId(jobId)) {
      ws.close(1008, 'valid jobId required');
      return;
    }
    if (!jobSockets.has(jobId)) jobSockets.set(jobId, new Set());
    jobSockets.get(jobId).add(ws);
    ws.on('close', () => {
      const set = jobSockets.get(jobId);
      if (!set) return;
      set.delete(ws);
      if (set.size === 0) jobSockets.delete(jobId);
    });
  });

  server.on('close', () => clearInterval(sweeper));

  return { server, wss, jobs, uploadDir: UPLOAD_DIR, outputDir: OUTPUT_DIR };
}

/**
 * Start the conversion server. Resolves with { server, host, port, close }.
 */
function startConvertServer({ port = DEFAULT_PORT, host = getBindHost(), workDir } = {}) {
  const instance = createConvertServer({ workDir });
  return new Promise((resolve, reject) => {
    instance.server.once('error', reject);
    instance.server.listen(port, host, () => {
      instance.server.off('error', reject);
      const actualPort = instance.server.address().port;
      console.log(`[CONVERT-SERVER] Native streaming conversion server running on http://${host}:${actualPort}`);
      console.log(`[CONVERT-SERVER] Using native FFmpeg: ${FFMPEG_PATH}`);
      resolve({
        ...instance,
        host,
        port: actualPort,
        close: () => new Promise((r) => {
          instance.wss.close();
          instance.server.close(() => r());
        }),
      });
    });
  });
}

if (require.main === module) {
  startConvertServer().catch((err) => {
    console.error('[CONVERT-SERVER] Failed to start:', err.message);
    process.exit(1);
  });
}

module.exports = { createConvertServer, startConvertServer, buildConvertArgs, RequestError };
