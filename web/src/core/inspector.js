/**
 * LAS CONVERT — Media Inspector
 * Uses ffmpeg probe when available, plus magic-byte fallback.
 */

class MediaInspector {
  async inspect(file) {
    if (window.ffmpegBridge && window.ffmpegBridge.probe) {
      try {
        const probed = await window.ffmpegBridge.probe(file, () => {});
        return {
          filename: file.name,
          extension: (file.name || '').split('.').pop().toUpperCase(),
          size: this.formatBytes(file.size || 0),
          duration: probed.duration || 'Unknown',
          overallBitrate: probed.overallBitrate || 'Unknown',
          container: probed.container || 'Unknown',
          video: {
            codec: probed.video.codec,
            resolution: probed.video.resolution,
            fps: probed.video.fps,
            colorspace: probed.video.colorspace
          },
          audio: {
            codec: probed.audio.codec,
            channels: probed.audio.channels,
            sampleRate: probed.audio.sampleRate,
            bitDepth: probed.audio.bitDepth
          },
          rawTree: probed.rawTree
        };
      } catch (err) {
        console.warn('FFmpeg probe failed, using header inspect', err);
      }
    }
    const ext = (file.name || '').split('.').pop().toLowerCase();
    const slice = file.slice(0, 8192);
    const bytes = new Uint8Array(await slice.arrayBuffer());
    return this.analyzeHeaders(file, ext, file.size || 0, bytes);
  }

  analyzeHeaders(file, ext, size, bytes) {
    const formattedSize = this.formatBytes(size);
    const sig = Array.from(bytes.slice(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    let container = ext.toUpperCase();
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) container = 'MP3 (ID3)';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) container = 'RIFF (WAV/AVI/WEBP)';
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) container = 'ISO BMFF (MP4/MOV/M4A)';

    const isAudio = ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'opus'].includes(ext);
    const isImage = ['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'gif'].includes(ext);

    return {
      filename: file.name,
      extension: ext.toUpperCase(),
      size: formattedSize,
      duration: isImage ? 'N/A' : 'Unknown (open with Convert for full probe)',
      overallBitrate: 'Unknown',
      container,
      video: {
        codec: isAudio ? 'None (Audio Only)' : (isImage ? ext.toUpperCase() + ' raster' : 'Unknown'),
        resolution: 'N/A',
        fps: isImage ? 'Static' : 'N/A',
        colorspace: isImage ? 'sRGB' : 'N/A'
      },
      audio: {
        codec: isImage ? 'None' : (isAudio ? ext.toUpperCase() : 'Unknown'),
        channels: 'N/A',
        sampleRate: 'N/A',
        bitDepth: 'N/A'
      },
      rawTree: `File: ${file.name}\nSize: ${formattedSize}\nMagic: ${sig}\nMIME: ${file.type || 'n/a'}`
    };
  }

  formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

window.mediaInspector = new MediaInspector();
