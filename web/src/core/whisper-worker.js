/**
 * LAS CONVERT — Whisper AI Speech-to-Text Background Web Worker
 * Uses Xenova/whisper-base (and Xenova/whisper-small / whisper-tiny)
 * 
 * FIX: Memoized model loading promise (singleton) + serial FIFO inference queue.
 * Prevents multiple chunks from triggering concurrent re-initialization (from_pretrained),
 * eliminating model reload storms and inference timeouts.
 */

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3';

env.allowLocalModels = false;
if (env.useBrowserCache !== undefined) {
  env.useBrowserCache = true;
}

// Memoized singleton promise for model loading
let transcriberPromise = null;
let currentModelName = null;

// Serial FIFO queue ensures one-at-a-time inference without collisions
let queue = Promise.resolve();

function getTranscriber(modelToUse) {
  if (!transcriberPromise || currentModelName !== modelToUse) {
    currentModelName = modelToUse;
    transcriberPromise = (async () => {
      self.postMessage({ status: 'loading', type: 'model-load-progress', message: `Initializing Whisper AI model (${modelToUse})...` });

      const hasWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
      let pipelineOpts = {
        device: hasWebGPU ? 'webgpu' : 'wasm',
        dtype: hasWebGPU ? 'fp32' : 'q8',
        progress_callback: (progress) => {
          if (progress && progress.status) {
            self.postMessage({ status: 'progress', type: 'model-load-progress', progress, data: progress });
          }
        }
      };

      let instance = null;
      try {
        instance = await pipeline('automatic-speech-recognition', modelToUse, pipelineOpts);
      } catch (gpuErr) {
        console.warn('[Whisper Worker] WebGPU initialization failed or unsupported, falling back to WASM:', gpuErr);
        pipelineOpts.device = 'wasm';
        pipelineOpts.dtype = 'q8';
        instance = await pipeline('automatic-speech-recognition', modelToUse, pipelineOpts);
      }

      self.postMessage({ status: 'model_ready', type: 'warmup-complete', model: modelToUse });
      return instance;
    })();
  }
  return transcriberPromise;
}

self.addEventListener('message', async (event) => {
  const data = event.data || {};
  const { action, type, id, audioData, selectedModel, language, isEnglish, samples } = data;

  const defaultModel = isEnglish ? 'Xenova/whisper-base.en' : 'Xenova/whisper-base';
  let modelToUse = selectedModel || defaultModel;
  if (modelToUse.startsWith('onnx-community/')) {
    modelToUse = modelToUse.replace('onnx-community/', 'Xenova/');
  }

  // 1. Warmup action: pre-load model into cache before audio chunks arrive
  if (action === 'warmup' || type === 'warmup') {
    try {
      await getTranscriber(modelToUse);
      self.postMessage({ status: 'model_ready', type: 'warmup-complete', id, model: modelToUse });
    } catch (err) {
      console.error('[Whisper Worker] Warmup error:', err);
      self.postMessage({ status: 'error', type: 'error', id, error: err.message, message: err.message });
    }
    return;
  }

  // 2. Transcription action (from file or live-dictation chunk)
  if (action === 'transcribe' || type === 'transcribe-chunk') {
    const rawAudio = audioData || samples;
    if (!rawAudio || !(rawAudio instanceof Float32Array)) {
      self.postMessage({ status: 'error', type: 'error', id, message: 'Invalid audio data. Expected a Float32Array.' });
      return;
    }

    // Queue inference serially
    queue = queue.then(async () => {
      try {
        const transcriber = await getTranscriber(modelToUse);

        const transcribeOptions = {
          return_timestamps: 'word',
          chunk_length_s: 30,
          stride_length_s: 5,
          repetition_penalty: 1.2,
          no_repeat_ngram_size: 3,
          temperature: 0.0
        };

        if (language && !isEnglish && !modelToUse.endsWith('.en')) {
          const langCode = language.split('-')[0].toLowerCase();
          transcribeOptions.language = langCode;
        }

        const output = await transcriber(rawAudio, transcribeOptions);

        self.postMessage({
          status: 'complete',
          type: 'transcribe-result',
          id,
          result: output,
          text: (output && output.text) ? output.text : ''
        });
      } catch (err) {
        console.error('[Whisper Worker] Transcription error:', err);
        self.postMessage({
          status: 'error',
          type: 'error',
          id,
          message: err.message || String(err),
          error: err.message || String(err)
        });
      }
    });
  }
});
