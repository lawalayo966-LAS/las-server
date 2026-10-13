/**
 * LAS CONVERT — ffmpeg.wasm bridge
 * Real video/audio transcode, extract, compress, trim, and probe.
 */

import { FFmpeg } from '../../node_modules/@ffmpeg/ffmpeg/dist/esm/index.js';
import { fetchFile, toBlobURL } from '../../node_modules/@ffmpeg/util/dist/esm/index.js';
import { ServerStreamingEngine } from './server-bridge.js';

// Above this size files are routed to the native server engine (WASM heap limits).
const WASM_SAFE_LIMIT_BYTES = 500 * 1024 * 1024;

const MIME_BY_FORMAT = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/mp4',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  gif: 'image/gif',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',
  m4v: 'video/mp4'
};

class FFmpegBridge {
  constructor() {
    this.ffmpeg = new FFmpeg();
    this.loadPromise = null;
    this.runQueue = Promise.resolve();
    this.lastLogs = [];
  }

  enqueue(job) {
    const pending = this.runQueue.then(job, job);
    this.runQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  safeExt(name, fallback = 'bin') {
    const raw = String(name || '').split('.').pop() || '';
    const ext = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
    return ext || fallback;
  }

  mimeFor(fmt) {
    return MIME_BY_FORMAT[(fmt || '').toLowerCase()] || 'application/octet-stream';
  }

  async ensureLoaded(progressCallback = () => {}) {
    if (this.ffmpeg.loaded) return;
    if (this.loadPromise) {
      await this.loadPromise;
      return;
    }

    this.loadPromise = this._loadCore(progressCallback);
    try {
      await this.loadPromise;
    } catch (err) {
      this.loadPromise = null;
      throw err;
    }
  }

  async _loadCore(progressCallback) {
    progressCallback({ percent: 4, stage: 'Loading FFmpeg engine...' });

    const coreBase = new URL('../../node_modules/@ffmpeg/core/dist/esm/', import.meta.url);
    const ffmpegPkg = new URL('../../node_modules/@ffmpeg/ffmpeg/dist/esm/', import.meta.url);

    const coreURL = await toBlobURL(new URL('ffmpeg-core.js', coreBase).href, 'text/javascript');
    progressCallback({ percent: 8, stage: 'Fetching FFmpeg WebAssembly core...' });
    const wasmURL = await toBlobURL(new URL('ffmpeg-core.wasm', coreBase).href, 'application/wasm');
    const classWorkerURL = new URL('worker.js', ffmpegPkg).href;

    this.ffmpeg.on('log', ({ message }) => {
      if (!message) return;
      this.lastLogs.push(message);
      if (this.lastLogs.length > 80) this.lastLogs.shift();
      console.debug('[ffmpeg]', message);
    });

    await this.ffmpeg.load({
      coreURL,
      wasmURL,
      classWorkerURL
    });

    progressCallback({ percent: 12, stage: 'FFmpeg engine ready.' });
  }

  extractAudio(file, targetFormat = 'mp3', options = {}, progressCallback = () => {}) {
    return this.enqueue(() => this._extractAudio(file, targetFormat, options, progressCallback));
  }

  transcode(file, targetFormat = 'mp4', options = {}, progressCallback = () => {}) {
    return this.enqueue(() => this._transcode(file, targetFormat, options, progressCallback));
  }

  compress(file, ratioPercent = 50, progressCallback = () => {}) {
    return this.enqueue(() => this._compress(file, ratioPercent, progressCallback));
  }

  trim(file, options = {}, progressCallback = () => {}) {
    return this.enqueue(() => this._trim(file, options, progressCallback));
  }

  probe(file, progressCallback = () => {}) {
    return this.enqueue(() => this._probe(file, progressCallback));
  }

  buildAudioArgs(targetFormat, options = {}, inputName = 'input.bin') {
    const fmt = (targetFormat || 'mp3').toLowerCase();
    const bitrate = parseInt(options.bitrate, 10) || 192;
    const channels = (options.channels || 'original').toLowerCase();
    const outName = `output.${fmt === 'aac' ? 'm4a' : fmt}`;
    const args = ['-i', inputName, '-vn'];

    if (channels === 'mono') args.push('-ac', '1');
    else if (channels === 'stereo') args.push('-ac', '2');

    if (fmt === 'wav') {
      args.push('-c:a', 'pcm_s16le', '-ar', options.sampleRate ? String(options.sampleRate) : '44100');
    } else if (fmt === 'flac') {
      args.push('-c:a', 'flac');
    } else if (fmt === 'aac' || fmt === 'm4a') {
      args.push('-c:a', 'aac', '-b:a', `${bitrate}k`);
    } else if (fmt === 'ogg') {
      // VBR quality: libvorbis rejects many fixed bitrates (e.g. low sample rates)
      args.push('-c:a', 'libvorbis', '-q:a', String(Math.max(0, Math.min(10, Math.round(bitrate / 32)))));
    } else if (fmt === 'opus') {
      args.push('-c:a', 'libopus', '-b:a', `${Math.min(bitrate, 256)}k`);
    } else {
      args.push('-c:a', 'libmp3lame', '-b:a', `${bitrate}k`);
    }

    args.push(outName);
    return { args, outName, fmt: fmt === 'aac' ? 'm4a' : fmt };
  }

  buildVideoArgs(targetFormat, options = {}, inputName = 'input.bin') {
    const fmt = (targetFormat || 'mp4').toLowerCase();
    const quality = (options.quality || options.preset || 'high').toLowerCase();
    const qv = quality === 'ultra' ? '3' : quality === 'low' ? '10' : '5';
    const outName = `output.${fmt}`;
    const args = ['-i', inputName];
    const vf = [];

    if (options.resolution === '1080p') vf.push('scale=-2:1080');
    else if (options.resolution === '720p') vf.push('scale=-2:720');
    else if (options.resolution === '480p') vf.push('scale=-2:480');

    if (fmt === 'gif') {
      vf.push('fps=10', 'scale=480:-1:flags=lanczos');
      args.push('-vf', vf.join(','), '-loop', '0', outName);
      return { args, outName, fmt };
    }

    if (vf.length) args.push('-vf', vf.join(','));

    if (fmt === 'webm') {
      args.push('-c:v', 'libvpx', '-b:v', quality === 'low' ? '500k' : '1M', '-c:a', 'libvorbis');
    } else {
      args.push('-c:v', 'mpeg4', '-q:v', qv, '-c:a', 'aac', '-b:a', '160k');
    }

    args.push(outName);
    return { args, outName, fmt };
  }

  /**
   * Run an ffmpeg.wasm job. Files above the WebAssembly-safe limit are routed
   * to the native local server engine using `serverJob`, which describes the
   * SAME operation (target format / compression), so large files are no
   * longer silently turned into MP4. Operations the server cannot perform
   * (serverJob = null, e.g. trim) fail with a clear error instead.
   */
  async _run(file, args, outName, mime, progressCallback, stage, serverJob = null) {
    const rawInput = (file && file.file) ? file.file : file;
    if (rawInput && rawInput.size && rawInput.size > WASM_SAFE_LIMIT_BYTES) {
      const sizeGb = (rawInput.size / (1024 * 1024 * 1024)).toFixed(2);
      const ServerEngineClass = (typeof window !== 'undefined' && window.ServerStreamingEngine) || ServerStreamingEngine;
      if (!serverJob) {
        throw new Error(`File size ${sizeGb} GB exceeds in-browser WebAssembly memory limits, and this operation is not available in the native server engine.`);
      }
      if (!ServerEngineClass) {
        throw new Error(`File size ${sizeGb} GB exceeds in-browser WebAssembly memory limits. Please run the local server streaming engine (npm run serve).`);
      }
      const server = new ServerEngineClass({ onProgress: progressCallback });
      if (serverJob.kind === 'compress') {
        return await server.compress(file, { ratioPercent: serverJob.ratioPercent, mode: 'force-media' });
      }
      return await server.convert(file, { ...(serverJob.options || {}), targetFormat: serverJob.targetFormat });
    }

    await this.ensureLoaded(progressCallback);
    const inExt = this.safeExt(file && file.name, 'bin');
    const inputName = `input.${inExt}`;
    const mappedArgs = args.map((a) => (a === '__INPUT__' ? inputName : a));

    const progressHandler = ({ progress, time }) => {
      // progress is a decimal (e.g., 0.45). Multiply by 100 to get the percentage.
      const rawPercent = Math.round(Math.min(1, Math.max(0, progress || 0)) * 100);
      const pct = Math.round(20 + Math.min(1, Math.max(0, progress || 0)) * 70);
      progressCallback({ percent: pct, rawPercent, progress, time, stage: `${stage} (${pct}%)...` });
    };

    this.ffmpeg.on('progress', progressHandler);
    this.lastLogs = [];

    try {
      progressCallback({ percent: 15, stage: 'Writing media into FFmpeg memory...' });
      const fileBytes = (rawInput && !(rawInput instanceof Blob) && !(rawInput instanceof File) && rawInput.buffer)
        ? new Uint8Array(rawInput.buffer)
        : (rawInput instanceof Blob || rawInput instanceof File)
        ? new Uint8Array(await rawInput.arrayBuffer())
        : await fetchFile(rawInput);
      await this.ffmpeg.writeFile(inputName, fileBytes);
      progressCallback({ percent: 20, stage });
      const code = await this.ffmpeg.exec(mappedArgs);
      if (code !== 0) {
        const hint = this.lastLogs.slice(-8).join(' | ') || 'Conversion failed.';
        throw new Error(`FFmpeg exited with code ${code}. ${hint}`);
      }
      progressCallback({ percent: 94, stage: 'Reading output file...' });
      const data = await this.ffmpeg.readFile(outName);
      
      // CRITICAL FIX: Delete the files from virtual memory immediately to prevent the black screen crash
      try { await this.ffmpeg.deleteFile(inputName); } catch (e) {}
      try { await this.ffmpeg.deleteFile(outName); } catch (e) {}

      // Construct Blob directly from data buffer to prevent doubling memory allocation in JavaScript heap
      const buffer = data.buffer ? data.buffer : (data instanceof Uint8Array ? data.buffer : data);
      return new Blob([buffer], { type: mime });
    } finally {
      this.ffmpeg.off('progress', progressHandler);
      try { await this.ffmpeg.deleteFile(inputName); } catch (e) {}
      try { await this.ffmpeg.deleteFile(outName); } catch (e) {}
    }
  }

  async _extractAudio(file, targetFormat, options, progressCallback) {
    const rawFile = (file && file.file) ? file.file : file;
    const isLarge = rawFile && rawFile.size && rawFile.size > 150 * 1024 * 1024;
    const isLocalServer = typeof window !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');

    if (isLarge || isLocalServer) {
      return convertLargeVideoToAudio(file, (p, stage) => {
        const pct = typeof p === 'number' ? p : (p && p.percent ? p.percent : 50);
        progressCallback({ percent: pct, stage: stage || `Processing audio (${pct}%)...` });
      }, { ...options, format: targetFormat });
    }

    const inExt = this.safeExt(file && file.name, (file && file.type && String(file.type).includes('audio')) ? 'wav' : 'mp4');
    const inputName = `input.${inExt}`;
    const { args, outName, fmt } = this.buildAudioArgs(targetFormat, options, '__INPUT__');
    const blob = await this._run(file, args, outName, this.mimeFor(fmt), progressCallback, 'Extracting / encoding audio',
      { kind: 'convert', targetFormat: fmt, options: { bitrate: options.bitrate } });
    progressCallback({ percent: 100, stage: 'Soundtrack extracted successfully.' });
    return blob;
  }

  async _transcode(file, targetFormat, options, progressCallback) {
    if (typeof window !== 'undefined' && window.ServerStreamingEngine && window.ServerStreamingEngine.shouldUseServerEngine(file)) {
      const server = new window.ServerStreamingEngine({ onProgress: progressCallback });
      return await server.convert(file, { targetFormat, ...options });
    }

    const fmt = (targetFormat || 'mp4').toLowerCase();
    const audioOnly = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus'].includes(fmt);
    if (audioOnly) {
      return this._extractAudio(file, fmt, options, progressCallback);
    }
    const { args, outName } = this.buildVideoArgs(fmt, options, '__INPUT__');
    const blob = await this._run(file, args, outName, this.mimeFor(fmt), progressCallback, `Transcoding to ${fmt.toUpperCase()}`,
      { kind: 'convert', targetFormat: fmt, options });
    progressCallback({ percent: 100, stage: 'Video conversion complete.' });
    return blob;
  }

  async _compress(file, ratioPercent, progressCallback) {
    const ext = this.safeExt(file && file.name, 'mp4');
    const ratio = Math.min(90, Math.max(10, parseInt(ratioPercent, 10) || 50));
    const qv = String(Math.round(3 + (ratio / 90) * 12));
    const audioBr = ratio > 60 ? '64k' : '128k';
    const isAudio = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus'].includes(ext);
    const outName = isAudio ? 'output.mp3' : `output.${ext === 'webm' ? 'webm' : 'mp4'}`;
    const args = isAudio
      ? ['-i', '__INPUT__', '-c:a', 'libmp3lame', '-b:a', audioBr, outName]
      : ['-i', '__INPUT__', '-c:v', 'mpeg4', '-q:v', qv, '-c:a', 'aac', '-b:a', audioBr, outName];
    const mime = isAudio ? 'audio/mpeg' : (ext === 'webm' ? 'video/webm' : 'video/mp4');
    const blob = await this._run(file, args, outName, mime, progressCallback, 'Compressing media',
      { kind: 'compress', ratioPercent: ratio });
    progressCallback({ percent: 100, stage: 'Compression complete.' });
    return blob;
  }

  async _trim(file, options, progressCallback) {
    const start = String(options.start || '00:00:00');
    const end = String(options.end || '00:00:10');
    const speed = parseFloat(options.speed) || 1;
    const ext = this.safeExt(file && file.name, 'mp4');
    const outName = `output.${ext === 'webm' ? 'webm' : 'mp4'}`;
    const args = ['-ss', start, '-to', end, '-i', '__INPUT__'];
    if (speed && speed !== 1) {
      const tempo = Math.max(0.5, Math.min(2, speed));
      args.push('-filter:v', `setpts=PTS/${tempo}`, '-filter:a', `atempo=${tempo}`);
    }
    if (outName.endsWith('.webm')) args.push('-c:v', 'libvpx', '-c:a', 'libvorbis', outName);
    else args.push('-c:v', 'mpeg4', '-c:a', 'aac', outName);
    // Trimming is not implemented by the native server engine -> serverJob = null.
    const blob = await this._run(file, args, outName, outName.endsWith('.webm') ? 'video/webm' : 'video/mp4', progressCallback, 'Rendering trimmed clip', null);
    progressCallback({ percent: 100, stage: 'Edit export complete.' });
    return blob;
  }

  async _probe(file, progressCallback) {
    await this.ensureLoaded(progressCallback);
    const inExt = this.safeExt(file && file.name, 'bin');
    const inputName = `input.${inExt}`;
    this.lastLogs = [];
    progressCallback({ percent: 30, stage: 'Reading container headers...' });
    try {
      const fileBytes = (file && file.buffer) ? new Uint8Array(file.buffer) : await fetchFile(file);
      await this.ffmpeg.writeFile(inputName, fileBytes);
      await this.ffmpeg.exec(['-hide_banner', '-i', inputName]);
    } catch (e) {
      // ffmpeg -i exits non-zero after printing probe info
    } finally {
      try { await this.ffmpeg.deleteFile(inputName); } catch (e) {}
    }
    progressCallback({ percent: 100, stage: 'Probe complete.' });
    return this.parseProbeLogs(file, this.lastLogs.join('\n'));
  }

  parseProbeLogs(file, logText) {
    const durationMatch = logText.match(/Duration:\s*(\d+:\d+:\d+\.\d+)/);
    const bitrateMatch = logText.match(/bitrate:\s*([0-9]+\s*kb\/s)/i);
    // Split the "Video:" stream line on commas that are not inside parentheses
    // (e.g. "yuv420p(tv, bt709)") instead of relying on a fixed field order.
    const videoLine = (logText.match(/Video:\s*([^\n]+)/) || [])[1];
    let videoMatch = null;
    if (videoLine) {
      const parts = []; let depth = 0; let cur = '';
      for (const ch of videoLine) {
        if (ch === '(' || ch === '[') depth++;
        if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
        if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
      }
      if (cur.trim()) parts.push(cur.trim());
      const res = parts.find((x) => /\d{2,5}x\d{2,5}/.test(x));
      const fpsPart = parts.find((x) => /\bfps\b/.test(x)) || parts.find((x) => /\btbr\b/.test(x));
      videoMatch = [null, parts[0] || 'Unknown', parts[1] || 'N/A',
        res ? res.match(/\d{2,5}x\d{2,5}/)[0] : 'N/A',
        fpsPart ? fpsPart.replace(/\s*(fps|tbr)\b.*/, '') + ' fps' : 'N/A'];
    }
    const audioMatch = logText.match(/Audio:\s*([^\n,]+),\s*([0-9]+ Hz),\s*([^,]+),[^,]*,\s*([^\n]+)/);
    const size = file.size || 0;
    const kbps = size && durationMatch ? Math.round((size * 8) / this.durationToSeconds(durationMatch[1]) / 1000) : 0;

    return {
      filename: file.name,
      size,
      duration: durationMatch ? durationMatch[1] : 'Unknown',
      overallBitrate: bitrateMatch ? bitrateMatch[1] : (kbps ? `${kbps} kb/s` : 'Unknown'),
      container: (file.name || '').split('.').pop().toUpperCase(),
      video: {
        codec: videoMatch ? videoMatch[1].trim() : 'None',
        colorspace: videoMatch ? videoMatch[2].trim() : 'N/A',
        resolution: videoMatch ? videoMatch[3] : 'N/A',
        fps: videoMatch ? videoMatch[4] : 'N/A'
      },
      audio: {
        codec: audioMatch ? audioMatch[1].trim() : 'None',
        sampleRate: audioMatch ? audioMatch[2] : 'N/A',
        channels: audioMatch ? audioMatch[3].trim() : 'N/A',
        bitDepth: audioMatch ? audioMatch[4].trim() : 'N/A'
      },
      rawTree: logText || 'No FFmpeg probe output.'
    };
  }

  durationToSeconds(hms) {
    const parts = String(hms).split(':').map(Number);
    if (parts.length < 3) return 1;
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  convertLargeVideoToAudio(videoFile, onProgress = () => {}, options = {}) {
    return this.enqueue(() => convertLargeVideoToAudio(videoFile, onProgress, options));
  }
}

const bridge = new FFmpegBridge();
window.ffmpegBridge = bridge;

function streamToServerNative(rawFile, fmt, cleanBitrate, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const endpoint = `/api/convert-large-video?format=${encodeURIComponent(fmt)}&bitrate=${encodeURIComponent(cleanBitrate.replace('k', ''))}`;
    xhr.open('POST', endpoint);
    xhr.responseType = 'blob';

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        const uploadPercent = Math.round((event.loaded / event.total) * 65);
        const currentMB = Math.round(event.loaded / (1024 * 1024));
        const totalMB = Math.round(event.total / (1024 * 1024));
        const pct = 15 + uploadPercent;
        if (typeof onProgress === 'function') {
          onProgress(pct, `Streaming to native 64-bit engine (${currentMB}MB / ${totalMB}MB - ${pct}%)...`);
        }
      }
    };

    xhr.upload.onload = () => {
      if (typeof onProgress === 'function') {
        onProgress(85, 'Upload complete. Native 64-bit FFmpeg extracting audio on disk...');
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
        if (typeof onProgress === 'function') onProgress(100, 'Soundtrack Extracted Successfully!');
        resolve(xhr.response);
      } else {
        reject(new Error(`Server native conversion failed (HTTP ${xhr.status})`));
      }
    };

    xhr.onerror = () => reject(new Error('Network connection error streaming file to local server'));
    xhr.ontimeout = () => reject(new Error('Timeout streaming file to local server'));

    xhr.send(rawFile);
  });
}

/**
 * Memory-safe conversion of large video files (up to 3GB) directly to audio.
 * Bypasses FileReader RAM spikes, discards the video track (-vn), sets clean audio bitrate,
 * and immediately purges virtual memory to prevent browser crashes.
 */
export async function convertLargeVideoToAudio(videoFile, onProgress = () => {}, options = {}) {
  const rawFile = (videoFile && videoFile.file) ? videoFile.file : videoFile;
  const fileSize = (rawFile && rawFile.size) ? rawFile.size : 0;
  const bitrate = options.bitrate || '192k';
  const cleanBitrate = String(bitrate).endsWith('k') ? bitrate : `${bitrate}k`;
  const fmt = (options.format || 'mp3').toLowerCase();

  // 1. Solution: Delegate large files (> 200MB or localhost server) to native FFmpeg binary (ZERO WASM heap limits)
  const isLocalServer = typeof window !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
  const ServerEngineClass = (typeof window !== 'undefined' && window.ServerStreamingEngine) || ServerStreamingEngine;
  if ((fileSize > 200 * 1024 * 1024 || isLocalServer) && ServerEngineClass) {
    try {
      console.log(`[DELEGATION] Streaming large video (${(fileSize / (1024 * 1024)).toFixed(1)} MB) to native streaming engine...`);
      const server = new ServerEngineClass({
        onProgress: (p) => {
          const pct = typeof p === 'number' ? p : (p && p.percent ? p.percent : 50);
          const st = typeof p === 'object' && p.stage ? p.stage : `Processing audio (${pct}%)...`;
          if (typeof onProgress === 'function') onProgress(pct, st);
        }
      });
      return await server.convert(rawFile, {
        ...options,
        targetFormat: fmt,
        bitrate: cleanBitrate
      });
    } catch (netErr) {
      console.warn('[DELEGATION] Server native conversion failed or unreachable:', netErr);
      if (fileSize > 1.2 * 1024 * 1024 * 1024) {
        const errorMsg = `This file is ${(fileSize / (1024 * 1024 * 1024)).toFixed(2)} GB, which exceeds the browser 32-bit WebAssembly memory ceiling (~1.5 GB). Please ensure the LAS CONVERT local server is running (npm run serve) so it can process unlimited files natively.`;
        if (typeof window !== 'undefined' && window.alert) alert(errorMsg);
        throw new Error(errorMsg);
      }
    }
  }

  // 2. WebAssembly 32-bit memory ceiling safeguard (> 1.5GB cannot fit in browser WASM heap)
  if (fileSize > 1.5 * 1024 * 1024 * 1024) {
    const errorMsg = `This file is ${(fileSize / (1024 * 1024 * 1024)).toFixed(2)} GB, which exceeds the browser 32-bit WebAssembly memory limit (~1.5 GB). Please run the local server (npm run serve) or the Windows Desktop App (.exe) for unlimited file sizes.`;
    if (typeof window !== 'undefined' && window.alert) alert(errorMsg);
    throw new Error(errorMsg);
  }

  try {
    await bridge.ensureLoaded((p) => {
      if (typeof onProgress === 'function') onProgress(typeof p === 'number' ? p : (p.percent || 5));
    });

    const ffmpeg = bridge.ffmpeg;
    const inExt = bridge.safeExt(videoFile && videoFile.name, 'mp4');
    const inputName = `input_heavy.${inExt}`;
    // Honour the requested format (this fallback used to always produce MP3).
    const { args: audioArgs, outName: outputName, fmt: outFmt } = bridge.buildAudioArgs(
      fmt,
      { ...options, bitrate: parseInt(cleanBitrate, 10) },
      inputName
    );

    // 1. Hook into progress so we can show a % bar on screen
    const progressHandler = ({ progress }) => {
      const percent = Math.round(Math.min(1, Math.max(0, progress || 0)) * 100);
      if (onProgress && typeof onProgress === 'function') {
        onProgress(percent);
      }
    };
    ffmpeg.on('progress', progressHandler);

    // 2. Enable verbose FFmpeg logs to see exact demux / decode errors
    const logHandler = ({ message }) => {
      console.log(`[FFmpeg-Core]: ${message}`);
    };
    ffmpeg.on('log', logHandler);

    try {
      console.log("Loading file stream into WebAssembly memory...");
      if (typeof onProgress === 'function') onProgress(10);
      const rawFile = (videoFile && videoFile.file) ? videoFile.file : videoFile;

      // Read full blob stream directly into a Uint8Array buffer without FileReader
      const fileBuffer = (rawFile instanceof Blob || rawFile instanceof File)
        ? new Uint8Array(await rawFile.arrayBuffer())
        : (rawFile && rawFile.buffer ? new Uint8Array(rawFile.buffer) : await fetchFile(rawFile));
      await ffmpeg.writeFile(inputName, fileBuffer);

      console.log("Starting conversion...");
      if (typeof onProgress === 'function') onProgress(25);

      // buildAudioArgs adds -vn (drops the heavy video track) and the codec/bitrate for the format
      const exitCode = await ffmpeg.exec(audioArgs);

      if (exitCode !== 0) {
        throw new Error(`FFmpeg conversion failed with exit code ${exitCode}`);
      }

      console.log('Reading final audio file...');
      if (typeof onProgress === 'function') onProgress(92);
      const data = await ffmpeg.readFile(outputName);

      // 3. CRITICAL: Clean up virtual memory immediately to prevent crashes
      try { await ffmpeg.deleteFile(inputName); } catch (e) {}
      try { await ffmpeg.deleteFile(outputName); } catch (e) {}

      if (typeof onProgress === 'function') onProgress(100);

      // Return the final audio blob
      const buffer = data.buffer ? data.buffer : (data instanceof Uint8Array ? data.buffer : data);
      return new Blob([buffer], { type: bridge.mimeFor(outFmt) });
    } finally {
      ffmpeg.off('progress', progressHandler);
      ffmpeg.off('log', logHandler);
      // Force cleanup on failure or completion
      try { await ffmpeg.deleteFile(inputName); } catch (e) {}
      try { await ffmpeg.deleteFile(outputName); } catch (e) {}
    }
  } catch (error) {
    console.error('Video-to-audio conversion failed:', error);
    if (typeof window !== 'undefined' && window.alert) {
      console.warn('Conversion failed. The file might be too large for current device memory.');
    }
    throw error;
  }
}

/**
 * Make a large File/Blob available to ffmpeg.wasm without overwriting data.
 *
 * Preferred path: mount the file with WORKERFS, which lets ffmpeg read it
 * lazily from the Blob (no copy into the WASM heap). If mounting is not
 * available, the file is read in 64 MB chunks into ONE buffer and written
 * once (the previous version called writeFile per chunk, so every chunk
 * overwrote the last and only the final 64 MB survived).
 *
 * @returns {Promise<{ path: string, cleanup: () => Promise<void> }>} path to pass to `-i`
 */
export async function streamFileToWasm(ffmpeg, file, targetFilename, onProgress) {
  const report = (pct) => {
    if (typeof onProgress === 'function') onProgress(pct);
  };
  const safeName = String(targetFilename || 'input.bin').replace(/[^a-zA-Z0-9._-]/g, '_');

  if (typeof ffmpeg.mount === 'function' && typeof File !== 'undefined') {
    const mountDir = `/las_mnt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const named = new File([file], safeName, { type: file.type || 'application/octet-stream' });
    await ffmpeg.createDir(mountDir);
    try {
      await ffmpeg.mount('WORKERFS', { files: [named] }, mountDir);
    } catch (mountErr) {
      try { await ffmpeg.deleteDir(mountDir); } catch (e) {}
      console.warn('[streamFileToWasm] WORKERFS mount failed, falling back to buffered write:', mountErr);
      return bufferedWrite();
    }
    report(100);
    return {
      path: `${mountDir}/${safeName}`,
      cleanup: async () => {
        try { await ffmpeg.unmount(mountDir); } catch (e) {}
        try { await ffmpeg.deleteDir(mountDir); } catch (e) {}
      }
    };
  }
  return bufferedWrite();

  async function bufferedWrite() {
    const CHUNK_SIZE = 64 * 1024 * 1024; // 64 MB blocks
    const out = new Uint8Array(file.size);
    let offset = 0;
    while (offset < file.size) {
      const nextOffset = Math.min(offset + CHUNK_SIZE, file.size);
      const chunk = new Uint8Array(await file.slice(offset, nextOffset).arrayBuffer());
      out.set(chunk, offset);
      offset = nextOffset;
      report(Math.round((offset / file.size) * 100));
    }
    await ffmpeg.writeFile(safeName, out);
    return {
      path: safeName,
      cleanup: async () => {
        try { await ffmpeg.deleteFile(safeName); } catch (e) {}
      }
    };
  }
}

if (typeof window !== 'undefined') {
  window.convertLargeVideoToAudio = convertLargeVideoToAudio;
  window.streamFileToWasm = streamFileToWasm;
}

export default bridge;

