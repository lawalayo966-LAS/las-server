/**
 * LAS CONVERT — Audio Extraction & Resampling Engine
 * Decodes audio from any supported video file and resamples to 16kHz mono Float32Array for Whisper AI
 */

/**
 * Decodes audio from any supported video file and resamples to 16kHz mono Float32Array for Whisper
 * @param {File|Blob} videoFile
 * @returns {Promise<Float32Array>}
 */
export async function extractAudioFromVideo(videoFile) {
  const arrayBuffer = await videoFile.arrayBuffer();
  
  // Standard AudioContext to decode container audio (AAC, AC3, MP3, etc.)
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    throw new Error('AudioContext is not supported in this browser/environment');
  }
  const audioCtx = new AudioCtx();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

  // Whisper models strictly require 16000Hz mono audio
  const targetSampleRate = 16000;
  const offlineCtx = new OfflineAudioContext(
    1, // 1 channel (mono)
    Math.ceil(audioBuffer.duration * targetSampleRate),
    targetSampleRate
  );

  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start(0);

  const renderedBuffer = await offlineCtx.startRendering();
  await audioCtx.close();

  return renderedBuffer.getChannelData(0); // Float32Array
}

if (typeof window !== 'undefined') {
  window.extractAudioFromVideo = extractAudioFromVideo;
}
