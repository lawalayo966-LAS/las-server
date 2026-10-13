/**
 * LAS CONVERT — Live Microphone Dictation & Streaming Translation Engine
 * 
 * Captures microphone audio, resamples to 16kHz mono Float32 PCM,
 * uses Voice Activity Detection (VAD) with energy thresholds to chunk on silence,
 * runs Whisper AI via WebGPU/WASM, and streams word-for-word translation in real time.
 */

const WHISPER_SAMPLE_RATE = 16000;
const SILENCE_THRESHOLD = 0.008;      // RMS energy below this = silence
const SILENCE_DURATION_MS = 600;     // Silence duration to trigger a chunk boundary
const MIN_CHUNK_DURATION_MS = 400;   // Ignore clicks/pops shorter than 400ms
const MAX_CHUNK_DURATION_MS = 6500;  // Force-flush after 6.5s to ensure continuous word count updates

export class LiveDictation {
  constructor({
    srcLang = 'en-US',
    targetLang = 'es-ES',
    model = 'Xenova/whisper-base.en',
    onWord = () => {},
    onStatusChange = () => {},
    onError = () => {}
  } = {}) {
    this.srcLang = srcLang;
    this.targetLang = targetLang;
    this.model = model;
    this.onWord = onWord;
    this.onStatusChange = onStatusChange;
    this.onError = onError;

    this.audioContext = null;
    this.mediaStream = null;
    this.sourceNode = null;
    this.workletNode = null;
    this.scriptNode = null;

    this._buffer = [];
    this._pendingBuffer = [];
    this._silenceStartedAt = null;
    this._chunkStartedAt = null;
    this._isRunning = false;
    this._isInferring = false;
    this._isWarming = false;
    this.allWords = [];

    this._onLoadProgress = (e) => {
      const p = (e && e.detail) ? (e.detail.data || e.detail.progress || e.detail) : null;
      if (p && this._isRunning && this._isWarming) {
        const pct = p.progress ? Math.round(p.progress * 100) : (p.loaded && p.total ? Math.round((p.loaded / p.total) * 100) : null);
        if (pct != null) {
          this.onStatusChange(`Loading Whisper AI model (${pct}%)...`);
        }
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('whisper-load-progress', this._onLoadProgress);
    }
  }

  async start() {
    if (this._isRunning) return;
    this._isRunning = true;
    this.allWords = [];

    try {
      this.onStatusChange('Requesting microphone permission...');
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Microphone access (getUserMedia) is not supported in this browser environment.');
      }

      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      // Warm up Whisper model singleton ONCE before audio pipeline begins producing chunks
      this._isWarming = true;
      this.onStatusChange('Loading Whisper AI model...');
      if (window.speechEngine && window.speechEngine.warmupWhisperWorker) {
        await window.speechEngine.warmupWhisperWorker({
          srcLang: this.srcLang,
          model: this.model
        });
      }
      this._isWarming = false;

      this.onStatusChange('Initializing 16kHz Audio Pipeline...');
      await this._setupAudioPipeline();

      this.onStatusChange('Live Listening & Translating...');
    } catch (err) {
      this._isRunning = false;
      this._isWarming = false;
      this.stop();
      this.onError(err);
    }
  }

  async _setupAudioPipeline() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error('Web Audio API (AudioContext) is not supported in this browser.');
    }

    // Attempt 16kHz context; if browser locks to 44.1k/48k, we resample dynamically
    try {
      this.audioContext = new AudioContextClass({ sampleRate: WHISPER_SAMPLE_RATE });
    } catch (e) {
      this.audioContext = new AudioContextClass();
    }

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

    // Try AudioWorklet first for off-main-thread processing
    let workletSuccess = false;
    if (this.audioContext.audioWorklet) {
      try {
        const workletBlobUrl = this._createWorkletBlob();
        await this.audioContext.audioWorklet.addModule(workletBlobUrl);
        this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-capture-processor');
        this.workletNode.port.onmessage = (e) => {
          if (!this._isRunning) return;
          this._handleSamples(e.data);
        };
        this.sourceNode.connect(this.workletNode);
        workletSuccess = true;
      } catch (workletErr) {
        console.warn('[LiveDictation] AudioWorklet init failed, falling back to ScriptProcessor:', workletErr);
      }
    }

    // Fallback: ScriptProcessorNode (universal cross-browser and Electron file:// support)
    if (!workletSuccess) {
      this.scriptNode = this.audioContext.createScriptProcessor(4096, 1, 1);
      this.scriptNode.onaudioprocess = (e) => {
        if (!this._isRunning) return;
        const channelData = e.inputBuffer.getChannelData(0);
        this._handleSamples(new Float32Array(channelData));
      };
      this.sourceNode.connect(this.scriptNode);
      // Connect to a silent gain to ensure Chrome/Safari processes scriptNode without playing back to speakers
      const muteGain = this.audioContext.createGain();
      muteGain.gain.value = 0;
      this.scriptNode.connect(muteGain);
      muteGain.connect(this.audioContext.destination);
    }
  }

  _createWorkletBlob() {
    const code = `
      class PCMCaptureProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const input = inputs[0];
          if (input && input[0]) {
            this.port.postMessage(input[0].slice());
          }
          return true;
        }
      }
      registerProcessor('pcm-capture-processor', PCMCaptureProcessor);
    `;
    return URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
  }

  _computeRMS(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }

  _handleSamples(samples) {
    if (!this._isRunning || !samples || samples.length === 0) return;

    const rms = this._computeRMS(samples);
    const now = performance.now();

    if (this._chunkStartedAt === null) {
      this._chunkStartedAt = now;
    }

    this._buffer.push(samples);

    const chunkDuration = now - this._chunkStartedAt;
    const isSilent = rms < SILENCE_THRESHOLD;

    if (isSilent) {
      if (this._silenceStartedAt === null) {
        this._silenceStartedAt = now;
      }
      const silenceDuration = now - this._silenceStartedAt;
      if (silenceDuration >= SILENCE_DURATION_MS && chunkDuration >= MIN_CHUNK_DURATION_MS) {
        this._flushChunk();
      }
    } else {
      this._silenceStartedAt = null; // Speech energy detected; reset silence timer
    }

    // Force flush if continuous speech exceeds max chunk duration
    if (chunkDuration >= MAX_CHUNK_DURATION_MS) {
      this._flushChunk();
    }
  }

  async _flushChunk() {
    if (this._buffer.length === 0) {
      this._chunkStartedAt = null;
      this._silenceStartedAt = null;
      return;
    }

    const merged = this._mergeBuffers(this._buffer);
    this._buffer = [];
    this._chunkStartedAt = null;
    this._silenceStartedAt = null;

    // Resample to 16kHz Float32 mono if needed
    const currentRate = this.audioContext ? this.audioContext.sampleRate : WHISPER_SAMPLE_RATE;
    const resampled = currentRate === WHISPER_SAMPLE_RATE
      ? merged
      : await this._resample(merged, currentRate, WHISPER_SAMPLE_RATE);

    // If Whisper is already busy transcribing previous chunk, queue into pending buffer
    if (this._isInferring) {
      this._pendingBuffer.push(resampled);
      return;
    }

    this._dispatchToWhisper(resampled);
  }

  async _dispatchToWhisper(float32Array) {
    this._isInferring = true;

    try {
      let result = null;

      // Delegate to SpeechEngine background Whisper Web Worker
      if (window.speechEngine && window.speechEngine.transcribeFloat32Array) {
        result = await window.speechEngine.transcribeFloat32Array(float32Array, {
          srcLang: this.srcLang,
          model: this.model
        });
      } else {
        console.warn('[LiveDictation] window.speechEngine.transcribeFloat32Array not available.');
      }

      if (result) {
        const rawText = (result.text || '').trim();
        // Extract words from chunks or text
        let newWords = [];
        if (result.chunks && Array.isArray(result.chunks) && result.chunks.length > 0) {
          result.chunks.forEach(c => {
            const chunkWords = String(c.text || '').trim().split(/\s+/).filter(Boolean);
            newWords.push(...chunkWords);
          });
        } else if (rawText) {
          newWords = rawText.split(/\s+/).filter(Boolean);
        }

        // Clean out repetitive hallucination loops
        if (newWords.length > 0) {
          const filteredWords = [];
          for (let i = 0; i < newWords.length; i++) {
            const w = newWords[i].replace(/[.,?!]/g, '').trim();
            if (w) filteredWords.push(w);
          }

          if (filteredWords.length > 0) {
            this.allWords.push(...filteredWords);

            // Compute word-for-word translation for UI
            const wordPairs = this.allWords.map((w, idx) => ({
              index: idx + 1,
              word: w,
              translation: window.speechEngine ? window.speechEngine.translateWord(w, this.srcLang, this.targetLang) : w
            }));

            const fullSpoken = this.allWords.join(' ');
            const fullTranslated = wordPairs.map(wp => wp.translation).join(' ');

            this.onWord(wordPairs, fullSpoken, fullTranslated);
          }
        }
      }
    } catch (inferErr) {
      console.warn('[LiveDictation] Chunk inference error:', inferErr);
    } finally {
      this._isInferring = false;

      // If pending audio accumulated while inference ran, flush next chunk immediately
      if (this._pendingBuffer.length > 0 && this._isRunning) {
        const nextBatch = this._mergeBuffers(this._pendingBuffer);
        this._pendingBuffer = [];
        this._dispatchToWhisper(nextBatch);
      }
    }
  }

  _mergeBuffers(buffers) {
    let totalLength = 0;
    for (const b of buffers) totalLength += b.length;
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const b of buffers) {
      merged.set(b, offset);
      offset += b.length;
    }
    return merged;
  }

  async _resample(samples, fromRate, toRate) {
    try {
      const OfflineCtxClass = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (OfflineCtxClass) {
        const targetLength = Math.max(1, Math.round(samples.length * (toRate / fromRate)));
        const offlineCtx = new OfflineCtxClass(1, targetLength, toRate);
        const buffer = offlineCtx.createBuffer(1, samples.length, fromRate);
        buffer.copyToChannel(samples, 0);

        const source = offlineCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(offlineCtx.destination);
        source.start(0);

        const rendered = await offlineCtx.startRendering();
        return rendered.getChannelData(0);
      }
    } catch (e) {
      console.warn('[LiveDictation] OfflineAudioContext resampling failed, using linear interpolation fallback:', e);
    }

    // Linear interpolation fallback
    const ratio = fromRate / toRate;
    const newLength = Math.round(samples.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const pos = i * ratio;
      const index = Math.floor(pos);
      const frac = pos - index;
      const a = samples[index] || 0;
      const b = samples[index + 1] || a;
      result[i] = a + frac * (b - a);
    }
    return result;
  }

  stop() {
    this._isRunning = false;
    this._isInferring = false;

    // Final flush of remaining buffer
    if (this._buffer.length > 0) {
      this._flushChunk();
    }

    if (this.workletNode) {
      try { this.workletNode.disconnect(); } catch (e) {}
      this.workletNode = null;
    }

    if (this.scriptNode) {
      try { this.scriptNode.disconnect(); } catch (e) {}
      this.scriptNode = null;
    }

    if (this.sourceNode) {
      try { this.sourceNode.disconnect(); } catch (e) {}
      this.sourceNode = null;
    }

    if (this.mediaStream) {
      try {
        this.mediaStream.getTracks().forEach(t => t.stop());
      } catch (e) {}
      this.mediaStream = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      try { this.audioContext.close(); } catch (e) {}
      this.audioContext = null;
    }

    if (typeof document !== 'undefined' && this._onLoadProgress) {
      document.removeEventListener('whisper-load-progress', this._onLoadProgress);
    }

    this.onStatusChange('Stopped');
  }
}

if (typeof window !== 'undefined') {
  window.LiveDictation = LiveDictation;
}
