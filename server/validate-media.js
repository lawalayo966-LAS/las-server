// server/validate-media.js
//
// Runs ffprobe against an uploaded file BEFORE starting a compress/convert job.
// Rejects non-media files (e.g. .exe, .zip, corrupted archives) immediately
// with a clear descriptive message, preventing false progress bars from running.

const { spawn } = require('child_process');
const fs = require('fs');

const { FFMPEG_PATH, FFPROBE_PATH } = require('./binaries');

class MediaValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MediaValidationError';
  }
}

/**
 * Probe a file on disk using ffprobe and return parsed streams and format info.
 * Throws MediaValidationError if the file has no audio/video/image streams or cannot be demuxed.
 *
 * @param {string} filePath - Absolute path to the file on disk
 * @returns {Promise<{ streams: any[], format: any }>}
 */
function probeMedia(filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return reject(new MediaValidationError('File does not exist on disk.'));
    }

    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ];

    const proc = spawn(FFPROBE_PATH, args);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    proc.on('close', (code) => {
      if (code !== 0) {
        // Try fallback to ffmpeg -i if ffprobe errored unexpectedly
        return probeWithFFmpegFallback(filePath)
          .then(resolve)
          .catch(() => {
            const errDetail = stderr.trim().split('\n').slice(-2).join(' ') || `exit code ${code}`;
            reject(new MediaValidationError(`This doesn't look like a valid video, audio, or image container. (${errDetail})`));
          });
      }

      try {
        const info = JSON.parse(stdout || '{}');
        if (!info.streams || info.streams.length === 0) {
          return reject(new MediaValidationError('File contains no readable audio, video, or image streams.'));
        }
        resolve(info);
      } catch (err) {
        reject(new MediaValidationError(`Could not parse media container headers: ${err.message}`));
      }
    });

    proc.on('error', (err) => {
      // If ffprobe binary execution failed, try ffmpeg fallback
      probeWithFFmpegFallback(filePath)
        .then(resolve)
        .catch(() => {
          reject(new MediaValidationError(`Failed to run media probe: ${err.message}`));
        });
    });
  });
}

/**
 * Fallback probe using ffmpeg -i when ffprobe cannot run
 */
function probeWithFFmpegFallback(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, ['-i', filePath]);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('close', () => {
      const isInvalid = stderr.includes('Invalid data found when processing input') ||
                        stderr.includes('could not find codec parameters') ||
                        stderr.includes('matches no streams');

      if (isInvalid) {
        return reject(new MediaValidationError('File is not a valid media stream.'));
      }

      const hasVideo = stderr.includes('Video:');
      const hasAudio = stderr.includes('Audio:');

      if (!hasVideo && !hasAudio) {
        return reject(new MediaValidationError('File contains neither video nor audio streams.'));
      }

      const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      let durationSeconds = 0;
      if (match) {
        const [, h, m, s] = match;
        durationSeconds = parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(s);
      }

      resolve({
        streams: [
          ...(hasVideo ? [{ codec_type: 'video' }] : []),
          ...(hasAudio ? [{ codec_type: 'audio' }] : [])
        ],
        format: { duration: String(durationSeconds) }
      });
    });
    proc.on('error', reject);
  });
}

/**
 * Returns a media summary object, or throws MediaValidationError
 */
async function getMediaSummary(filePath) {
  const info = await probeMedia(filePath);

  const videoStream = info.streams.find((s) => s.codec_type === 'video');
  const audioStream = info.streams.find((s) => s.codec_type === 'audio');

  if (!videoStream && !audioStream) {
    throw new MediaValidationError(
      'File contains no readable video or audio stream — this is not a valid media file.'
    );
  }

  return {
    type: videoStream ? 'video' : 'audio',
    durationSeconds: parseFloat(info.format?.duration || '0'),
    sizeBytes: parseInt(info.format?.size || '0', 10),
    videoCodec: videoStream?.codec_name || null,
    audioCodec: audioStream?.codec_name || null,
    width: videoStream?.width || null,
    height: videoStream?.height || null,
  };
}

module.exports = { probeMedia, getMediaSummary, MediaValidationError };
