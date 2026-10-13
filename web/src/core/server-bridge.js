const DEFAULT_SERVER_BASE = (typeof window !== 'undefined' && window.CONVERT_SERVER_URL)
  ? window.CONVERT_SERVER_URL
  : 'http://localhost:4501'; // the convert-server binds to 127.0.0.1 by default

const WASM_SAFE_LIMIT_BYTES = 500 * 1024 * 1024; // 500MB safe threshold

export class ServerStreamingEngine {
  constructor({ onProgress } = {}) {
    this.onProgress = onProgress || (() => {});
    this.serverBase = DEFAULT_SERVER_BASE;
  }

  /**
   * Decide which engine should handle this file. Wire this into
   * engine.js in place of (or ahead of) the hard-coded size check
   * that currently throws in ffmpeg-bridge.js:192.
   */
  static shouldUseServerEngine(file) {
    const rawFile = (file && file.file) ? file.file : file;
    const size = (rawFile && rawFile.size) ? rawFile.size : 0;
    return size > WASM_SAFE_LIMIT_BYTES;
  }

  /**
   * Full pipeline: start upload session -> stream file to server ->
   * kick off native ffmpeg -> listen for progress -> resolve with a
   * Blob of the converted file once done.
   */
  async convert(file, options = {}) {
    const rawFile = (file && file.file) ? file.file : file;
    const {
      outputFormat = 'mp4',
      targetFormat = outputFormat,
      videoCodec = 'libx264',
      audioCodec = 'aac',
      crf = 18,
      bitrate,
    } = options;

    const fmt = (targetFormat || outputFormat || 'mp4').toLowerCase();
    const isAudioTarget = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus'].includes(fmt);
    const webm = fmt === 'webm';

    const { jobId, progressPromise } = await this._uploadJob(rawFile, 'video.mp4');

    // Only allowlisted options are sent; the server rejects raw ffmpeg arguments.
    const convertRes = await this._postJson('/api/convert', {
      jobId,
      outputFormat: fmt,
      videoCodec: isAudioTarget || fmt === 'gif' ? undefined : (webm ? 'libvpx-vp9' : videoCodec),
      audioCodec: isAudioTarget || fmt === 'gif' ? undefined : (webm ? 'libopus' : audioCodec),
      crf: isAudioTarget || fmt === 'gif' ? undefined : crf,
      audioBitrate: bitrate ? String(bitrate) : undefined,
    });
    if (!convertRes.ok) throw await this._errorFrom(convertRes, 'Failed to start native conversion on server');

    const { outputFile } = await progressPromise;
    return this._downloadOutput(outputFile);
  }

  async compress(file, options = {}) {
    const rawFile = (file && file.file) ? file.file : file;
    const ratioPercent = options.ratioPercent || 75;
    const mode = options.mode || 'auto';

    const { jobId, progressPromise } = await this._uploadJob(rawFile, 'file.bin');
    const compressRes = await this._postJson('/api/compress', { jobId, mode, ratioPercent });

    if (compressRes.status === 409) {
      const errData = await compressRes.json().catch(() => ({}));
      if (errData.suggestedEndpoint === '/api/archive/unzip' || errData.error === 'already_zip') {
        console.log('[ServerStreamingEngine] File is already a ZIP archive, automatically delegating to /api/archive/unzip...');
        const unzipRes = await this._postJson('/api/archive/unzip', { jobId });
        if (!unzipRes.ok) throw await this._errorFrom(unzipRes, 'Unzip failed');
        const { outputFile } = await progressPromise;
        return this._downloadOutput(outputFile);
      }
    }
    if (!compressRes.ok) throw await this._errorFrom(compressRes, 'Server compression failed to start');

    const { outputFile } = await progressPromise;
    return this._downloadOutput(outputFile);
  }

  async unzip(file) {
    const rawFile = (file && file.file) ? file.file : file;
    const { jobId, progressPromise } = await this._uploadJob(rawFile, 'archive.zip');
    const unzipRes = await this._postJson('/api/archive/unzip', { jobId });
    if (!unzipRes.ok) throw await this._errorFrom(unzipRes, 'Server unzip failed to start');
    const { outputFile } = await progressPromise;
    return this._downloadOutput(outputFile);
  }

  /**
   * Start an upload session, open the progress socket and stream the file.
   * The server generates the job id and all on-disk file names; the client
   * only ever refers to the job by its id.
   */
  async _uploadJob(rawFile, fallbackName) {
    const startBody = JSON.stringify({ fileName: rawFile.name || fallbackName, fileSize: rawFile.size });
    let startRes;
    try {
      startRes = await fetch(`${this.serverBase}/api/upload/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: startBody,
      });
    } catch (netErr) {
      throw new Error(`Could not reach the local conversion server at ${this.serverBase}. Start it with "npm run serve" (or use the desktop app). (${netErr.message})`);
    }
    if (!startRes.ok) {
      const body = await startRes.json().catch(() => ({}));
      throw new Error(`Failed to start upload session with local conversion server: ${body.message || startRes.statusText}`);
    }
    const { jobId } = await startRes.json();

    const socketProto = this.serverBase.startsWith('https') ? 'wss:' : 'ws:';
    const socketHost = new URL(this.serverBase).host;
    const socket = new WebSocket(`${socketProto}//${socketHost}/progress?jobId=${encodeURIComponent(jobId)}`);
    const progressPromise = this._listenForCompletion(socket);
    // Avoid unhandled rejections if we bail out before awaiting the promise.
    progressPromise.catch(() => {});
    await new Promise((resolve) => {
      if (socket.readyState === WebSocket.OPEN) return resolve();
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', resolve, { once: true });
    });

    // `rawFile` is a native File/Blob. XMLHttpRequest streams it from disk
    // without loading it into the JS heap. (A fetch() PUT with a File body and
    // `duplex: 'half'` crashes the Electron 28 renderer.)
    const status = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `${this.serverBase}/api/upload/${encodeURIComponent(jobId)}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.onload = () => resolve(xhr.status);
      xhr.onerror = () => reject(new Error('Streaming upload to the local conversion server failed'));
      xhr.send(rawFile);
    }).catch((e) => { try { socket.close(); } catch (_) {} throw e; });
    if (status < 200 || status >= 300) {
      try { socket.close(); } catch (e) {}
      throw new Error(`Streaming upload failed with status ${status}`);
    }
    return { jobId, socket, progressPromise };
  }

  async _postJson(pathname, body) {
    return fetch(`${this.serverBase}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async _downloadOutput(outputFile) {
    const downloadRes = await fetch(`${this.serverBase}/api/download/${encodeURIComponent(outputFile)}`);
    if (!downloadRes.ok) throw new Error(`Failed to download output from server: ${downloadRes.status}`);
    const blob = await downloadRes.blob();
    blob.serverOutputFileName = outputFile;
    return blob;
  }

  async _errorFrom(res, prefix) {
    const body = await res.json().catch(() => ({}));
    return new Error(`${prefix}: ${body.message || body.error || res.status}`);
  }

  _listenForCompletion(socket) {
    return new Promise((resolve, reject) => {
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.phase === 'uploading') {
            const p = Math.round(data.percent * 0.5); // 0-50%
            this.onProgress({ percent: p, stage: `Uploading to engine (${data.percent}%)...`, phase: 'uploading' });
          } else if (data.phase === 'zipping') {
            const p = Math.round(50 + data.percent * 0.49); // 50-99%
            this.onProgress({ percent: p, stage: `Packaging into ZIP archive (${data.percent}%)...`, phase: 'zipping' });
          } else if (data.phase === 'converting') {
            const p = Math.round(50 + data.percent * 0.49); // 50-99%
            this.onProgress({ percent: p, stage: `Compressing media (${data.percent}%)...`, phase: 'converting' });
          } else if (data.phase === 'extracting' || data.phase === 'repacking') {
            const p = Math.round(50 + data.percent * 0.49);
            this.onProgress({ percent: p, stage: `${data.phase === 'repacking' ? 'Repacking' : 'Extracting'} (${data.percent}%)...`, phase: data.phase });
          } else if (data.phase === 'done') {
            this.onProgress({ percent: 100, stage: 'Compression Complete!', phase: 'done' });
            socket.close();
            resolve(data);
          } else if (data.phase === 'error') {
            socket.close();
            reject(new Error(data.message || 'Compression error'));
          }
        } catch (e) {
          console.warn('Malformed progress message:', e);
        }
      };

      socket.onerror = () => {
        reject(new Error('Lost connection to local streaming conversion server'));
      };
      socket.onclose = () => {
        // No-op if the promise already settled with "done" / "error".
        reject(new Error('Progress connection closed before the job finished'));
      };
    });
  }
}

if (typeof window !== 'undefined') {
  window.ServerStreamingEngine = ServerStreamingEngine;
}
