/**
 * LAS CONVERT — Bulletproof Progressive Audio Engine
 * Ultra-smooth, non-blocking audio extraction & encoding.
 * Guaranteed zero-freeze, timeout-guarded decoding, and non-blocking micro-chunk encoding.
 */

class AudioEngine {
  constructor() {
    this.supportedFormats = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus'];
    this.audioCtx = null;
  }

  getAudioContext() {
    if (!this.audioCtx && typeof window !== 'undefined') {
      // Only used for decodeAudioData/createBuffer, so an OfflineAudioContext
      // is enough and needs no audio output device (a live AudioContext can
      // crash the renderer on machines without one).
      const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (Offline) {
        this.audioCtx = new Offline(2, 1, 44100);
      } else if (AudioCtxClass) {
        this.audioCtx = new AudioCtxClass();
      }
    }
    return this.audioCtx;
  }

  /**
   * Decode audio data with timeout guards and progressive non-blocking yielding
   */
  async decodeAudio(file, progressCallback = () => {}) {
    progressCallback({ percent: 15, stage: 'Reading media stream headers...' });
    await this.yieldControl();

    const audioCtx = this.getAudioContext();
    if (!audioCtx) {
      throw new Error('Web Audio API is not supported in this environment');
    }

    if (audioCtx.state === 'suspended' && !(window.OfflineAudioContext && audioCtx instanceof window.OfflineAudioContext)) {
      try { await audioCtx.resume(); } catch (e) {}
    }

    progressCallback({ percent: 30, stage: 'Analyzing audio track bitstream...' });
    await this.yieldControl();

    const ext = (file.name || '').split('.').pop().toLowerCase();
    const isPureAudio = ['mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'opus'].includes(ext) || (file.type && file.type.startsWith('audio/'));

    // If small pure audio file, attempt native WebAudio decode with strict 1.5s timeout
    if (isPureAudio && file.size < 40 * 1024 * 1024) {
      try {
        progressCallback({ percent: 50, stage: 'Decoding audio stream frames...' });
        await this.yieldControl();

        const arrayBuffer = (file && file.buffer) ? file.buffer : await file.arrayBuffer();
        const audioBuffer = await this.decodeWithTimeout(audioCtx, arrayBuffer, 1500);
        progressCallback({ percent: 65, stage: 'Audio stream decoded successfully.' });
        await this.yieldControl();
        return audioBuffer;
      } catch (err) {
        console.warn('Native decodeAudioData timed out or failed, using fast progressive stream decoder...', err);
      }
    }

    // For Video files (or if native decode failed/timed out)
    progressCallback({ percent: 50, stage: 'Demuxing video audio tracks...' });
    await this.yieldControl();

    return await this.decodeProceduralStream(file, progressCallback);
  }

  /**
   * Timeout-safe decodeAudioData wrapper that will never hang or block at 50%
   */
  decodeWithTimeout(audioCtx, arrayBuffer, timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('decodeAudioData timed out'));
        }
      }, timeoutMs);

      try {
        const copy = arrayBuffer.slice(0);
        audioCtx.decodeAudioData(
          copy,
          (buffer) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(buffer);
            }
          },
          (err) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(err || new Error('decodeAudioData rejected'));
            }
          }
        );
      } catch (e) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(e);
        }
      }
    });
  }

  /**
   * Previously this "decoder" synthesised a 220/440 Hz tone when the real
   * audio could not be decoded, silently producing fake output. It now fails
   * with a clear error so callers can fall back to FFmpeg or report it.
   */
  async decodeProceduralStream(file) {
    const name = (file && file.name) || 'this file';
    throw new Error(`Could not decode the audio track of ${name} in the browser. ` +
      'Use the FFmpeg-based conversion (Audio / Video tools) or run the local server (npm run serve).');
  }

  /**
   * Encode AudioBuffer into requested format without blocking the UI
   */
  async encodeAudio(audioBuffer, targetFormat = 'mp3', options = {}, progressCallback = () => {}) {
    const fmt = (targetFormat || 'mp3').toLowerCase();
    const bitrate = parseInt(options.bitrate, 10) || 192;
    const channels = options.channels || 'stereo';

    let workingBuffer = audioBuffer;
    if (channels === 'mono' && audioBuffer.numberOfChannels > 1) {
      workingBuffer = this.downmixToMono(audioBuffer);
    }

    if (fmt === 'wav') {
      return await this.audioBufferToWavAsync(workingBuffer, progressCallback);
    } else if (fmt === 'mp3') {
      return await this.audioBufferToMp3Async(workingBuffer, bitrate, progressCallback);
    } else if (fmt === 'flac') {
      return await this.audioBufferToFlacAsync(workingBuffer, progressCallback);
    } else if (fmt === 'aac' || fmt === 'm4a') {
      return await this.audioBufferToAacAsync(workingBuffer, bitrate, progressCallback);
    } else if (fmt === 'ogg' || fmt === 'opus') {
      return await this.audioBufferToOggAsync(workingBuffer, fmt, bitrate, progressCallback);
    }

    throw new Error(`Unsupported audio output format: ${fmt}`);
  }

  downmixToMono(audioBuffer) {
    const audioCtx = this.getAudioContext();
    const mono = audioCtx.createBuffer(1, audioBuffer.length, audioBuffer.sampleRate);
    const mData = mono.getChannelData(0);
    const left = audioBuffer.getChannelData(0);
    const right = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : left;

    for (let i = 0; i < audioBuffer.length; i++) {
      mData[i] = (left[i] + right[i]) * 0.5;
    }
    return mono;
  }

  /**
   * Chunked 16-bit PCM WAV Encoder with event-loop yielding
   */
  async audioBufferToWavAsync(audioBuffer, progressCallback = () => {}) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const totalSamples = audioBuffer.length;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = totalSamples * blockAlign;
    const headerSize = 44;
    const totalSize = headerSize + dataSize;

    progressCallback({ percent: 70, stage: 'Building RIFF headers...' });
    await this.yieldControl();

    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);

    this.writeString(view, 0, 'RIFF');
    view.setUint32(4, totalSize - 8, true);
    this.writeString(view, 8, 'WAVE');

    this.writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);

    this.writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    const left = audioBuffer.getChannelData(0);
    const right = numChannels > 1 ? audioBuffer.getChannelData(1) : left;

    let offset = 44;
    const chunkSize = 25000;

    for (let start = 0; start < totalSamples; start += chunkSize) {
      const end = Math.min(totalSamples, start + chunkSize);
      
      for (let i = start; i < end; i++) {
        let l = Math.max(-1, Math.min(1, left[i]));
        view.setInt16(offset, l < 0 ? l * 0x8000 : l * 0x7FFF, true);
        offset += 2;

        if (numChannels > 1) {
          let r = Math.max(-1, Math.min(1, right[i]));
          view.setInt16(offset, r < 0 ? r * 0x8000 : r * 0x7FFF, true);
          offset += 2;
        }
      }

      const pct = Math.round(70 + (end / totalSamples) * 28);
      progressCallback({ percent: pct, stage: `Quantizing 16-bit PCM master (${Math.round((end/totalSamples)*100)}%)...` });
      await this.yieldControl();
    }

    progressCallback({ percent: 100, stage: 'Finalizing WAV file...' });
    await this.yieldControl();

    return new Blob([view], { type: 'audio/wav' });
  }

  /**
   * Encode an AudioBuffer to a compressed format with real FFmpeg encoders.
   * (The old hand-written "MP3" encoder emitted noise, and FLAC/AAC/OGG/OPUS
   * were WAV or fake-MP3 data relabelled with another MIME type.)
   */
  async encodeViaFfmpeg(audioBuffer, fmt, bitrate = 192, progressCallback = () => {}) {
    const wavBlob = await this.audioBufferToWavAsync(audioBuffer, (p) => {
      const pct = typeof p === 'object' ? p.percent : p;
      progressCallback({ percent: Math.round(60 + (pct - 70) * 0.5), stage: 'Preparing PCM master...' });
    });
    const bridge = await this.waitForFfmpegBridge();
    const wavFile = new File([wavBlob], 'master.wav', { type: 'audio/wav' });
    return bridge.extractAudio(wavFile, fmt, { bitrate }, progressCallback);
  }

  async audioBufferToMp3Async(audioBuffer, bitrate = 192, progressCallback = () => {}) {
    return this.encodeViaFfmpeg(audioBuffer, 'mp3', bitrate, progressCallback);
  }

  async audioBufferToFlacAsync(audioBuffer, progressCallback = () => {}) {
    return this.encodeViaFfmpeg(audioBuffer, 'flac', 0, progressCallback);
  }

  async audioBufferToAacAsync(audioBuffer, bitrate = 192, progressCallback = () => {}) {
    return this.encodeViaFfmpeg(audioBuffer, 'm4a', bitrate, progressCallback);
  }

  async audioBufferToOggAsync(audioBuffer, fmt = 'ogg', bitrate = 192, progressCallback = () => {}) {
    return this.encodeViaFfmpeg(audioBuffer, fmt === 'opus' ? 'opus' : 'ogg', bitrate, progressCallback);
  }

  writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  yieldControl() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  waitForFfmpegBridge(timeoutMs = 20000) {
    if (window.ffmpegBridge) return Promise.resolve(window.ffmpegBridge);
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (window.ffmpegBridge) {
          clearInterval(timer);
          resolve(window.ffmpegBridge);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error('FFmpeg failed to load. Run npm install and serve the app over http (npm run serve) or Electron.'));
        }
      }, 50);
    });
  }

  async convert(file, targetFormat = 'mp3', options = {}, progressCallback = () => {}) {
    if (window.ServerStreamingEngine && window.ServerStreamingEngine.shouldUseServerEngine(file)) {
      const serverEngine = new window.ServerStreamingEngine({ onProgress: progressCallback });
      return serverEngine.convert(file, { targetFormat, ...options });
    }
    const bridge = await this.waitForFfmpegBridge();
    const outBlob = await bridge.extractAudio(file, targetFormat, options, progressCallback);
    progressCallback({ percent: 100, stage: 'Audio Conversion Complete!' });
    return outBlob;
  }

  async convertLargeVideoToAudio(videoFile, options = {}, progressCallback = () => {}) {
    if (window.ServerStreamingEngine && window.ServerStreamingEngine.shouldUseServerEngine(videoFile)) {
      const serverEngine = new window.ServerStreamingEngine({ onProgress: progressCallback });
      return serverEngine.convert(videoFile, { targetFormat: 'mp3', ...options });
    }
    const bridge = await this.waitForFfmpegBridge();
    if (bridge.convertLargeVideoToAudio) {
      return await bridge.convertLargeVideoToAudio(videoFile, (pct) => {
        progressCallback({ percent: pct, stage: `Extracting audio from large video (${pct}%)...` });
      }, options);
    }
    return await bridge.extractAudio(videoFile, 'mp3', options, progressCallback);
  }

  async extractAudioFromVideo(videoFile, targetFormat = 'mp3', options = {}, progressCallback = () => {}) {
    if (window.ServerStreamingEngine && window.ServerStreamingEngine.shouldUseServerEngine(videoFile)) {
      const serverEngine = new window.ServerStreamingEngine({ onProgress: progressCallback });
      return serverEngine.convert(videoFile, { targetFormat, ...options });
    }
    const bridge = await this.waitForFfmpegBridge();
    const isLarge = videoFile && videoFile.size && videoFile.size > 150 * 1024 * 1024;
    if ((targetFormat || '').toLowerCase() === 'mp3' && isLarge && bridge.convertLargeVideoToAudio) {
      const outBlob = await bridge.convertLargeVideoToAudio(videoFile, (pct) => {
        progressCallback({ percent: pct, stage: `Converting large video to MP3 (${pct}%)...` });
      }, options);
      progressCallback({ percent: 100, stage: 'Soundtrack Extracted Successfully!' });
      return outBlob;
    }
    const outBlob = await bridge.extractAudio(videoFile, targetFormat, options, progressCallback);
    progressCallback({ percent: 100, stage: 'Soundtrack Extracted Successfully!' });
    return outBlob;
  }

  async decodeExtractedPreview(blob, filename = 'preview.wav') {
    // Decode with an OfflineAudioContext: it needs no audio output device
    // (a live AudioContext can crash the renderer on systems without one).
    const Offline = typeof window !== 'undefined' && (window.OfflineAudioContext || window.webkitOfflineAudioContext);
    const audioCtx = Offline ? new Offline(1, 1, 44100) : this.getAudioContext();
    if (!audioCtx) return null;
    const arrayBuffer = await blob.arrayBuffer();
    try {
      return await this.decodeWithTimeout(audioCtx, arrayBuffer, 8000);
    } catch (err) {
      console.warn('Preview decode skipped:', err);
      return null;
    }
  }

  drawWaveform(canvas, audioBuffer = null) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#0a0c10';
    ctx.fillRect(0, 0, width, height);

    const bars = 90;
    const barWidth = width / bars;
    const peaks = [];

    if (audioBuffer && audioBuffer.length > 0) {
      const channelData = audioBuffer.getChannelData(0);
      const step = Math.max(1, Math.floor(channelData.length / bars));
      for (let i = 0; i < bars; i++) {
        let max = 0;
        const start = i * step;
        const end = Math.min(channelData.length, start + step);
        for (let j = start; j < end; j += 15) {
          const val = Math.abs(channelData[j]);
          if (val > max) max = val;
        }
        peaks.push(Math.max(0.12, max));
      }
    } else {
      for (let i = 0; i < bars; i++) {
        const factor = Math.sin((i / bars) * Math.PI * 4) * Math.cos((i / bars) * Math.PI * 2);
        peaks.push(Math.max(0.15, Math.abs(factor) + (Math.random() * 0.2)));
      }
    }

    for (let i = 0; i < bars; i++) {
      const x = i * barWidth;
      const amp = peaks[i] || 0.2;
      const barHeight = Math.min(height * 0.9, Math.max(4, amp * height * 0.88));
      const y = (height - barHeight) / 2;

      const grad = ctx.createLinearGradient(0, y, 0, y + barHeight);
      grad.addColorStop(0, '#00f0ff');
      grad.addColorStop(0.5, '#8b5cf6');
      grad.addColorStop(1, '#10b981');

      ctx.fillStyle = grad;
      ctx.fillRect(x + 1.5, y, Math.max(1, barWidth - 3), barHeight);
    }
  }
}

window.audioEngine = new AudioEngine();
