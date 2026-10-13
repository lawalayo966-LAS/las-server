/**
 * LAS CONVERT — Video Processing Core Engine
 * Real transcode via ffmpeg.wasm.
 */

class VideoEngine {
  constructor() {
    this.supportedFormats = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'm4v', 'gif'];
    this.supportedCodecs = {
      h264: 'H.264 / MPEG-4',
      hevc: 'H.265 / HEVC',
      vp9: 'VP9',
      av1: 'AV1',
      copy: 'Direct Stream Copy'
    };
  }

  async waitForBridge() {
    const started = Date.now();
    while (!window.ffmpegBridge) {
      if (Date.now() - started > 20000) {
        throw new Error('FFmpeg failed to load. Run npm install, then npm start or npm run serve.');
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return window.ffmpegBridge;
  }

  async convert(file, targetFormat = 'mp4', options = {}, progressCallback = () => {}) {
    if (window.ServerStreamingEngine && window.ServerStreamingEngine.shouldUseServerEngine(file)) {
      const serverEngine = new window.ServerStreamingEngine({ onProgress: progressCallback });
      return serverEngine.convert(file, { targetFormat, ...options });
    }
    const bridge = await this.waitForBridge();
    return bridge.transcode(file, targetFormat, options, progressCallback);
  }

  async extractAudio(videoFile, targetAudioFormat = 'mp3', options = {}, progressCallback = () => {}) {
    if (window.audioEngine) {
      return window.audioEngine.extractAudioFromVideo(videoFile, targetAudioFormat, options, progressCallback);
    }
    const bridge = await this.waitForBridge();
    return bridge.extractAudio(videoFile, targetAudioFormat, options, progressCallback);
  }

  async convertLargeVideoToAudio(videoFile, onProgress = () => {}, options = {}) {
    if (window.convertLargeVideoToAudio) {
      return window.convertLargeVideoToAudio(videoFile, onProgress, options);
    }
    const bridge = await this.waitForBridge();
    if (bridge.convertLargeVideoToAudio) {
      return bridge.convertLargeVideoToAudio(videoFile, onProgress, options);
    }
    return this.extractAudio(videoFile, 'mp3', options, onProgress);
  }
}

window.videoEngine = new VideoEngine();
