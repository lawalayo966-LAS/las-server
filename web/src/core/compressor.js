/**
 * LAS CONVERT — Smart Compressor & Streaming ZIP Engine
 * Uses @zip.js/zip.js with Web Workers and Blob streaming to handle gigabyte-level files without RAM exhaustion.
 */

let zipModule = null;

async function getZipEngine() {
  if (zipModule) return zipModule;
  if (typeof window !== 'undefined' && window.zip && window.zip.BlobWriter) {
    zipModule = window.zip;
    return zipModule;
  }
  try {
    zipModule = await import('@zip.js/zip.js');
    if (zipModule && zipModule.configure) {
      zipModule.configure({
        useWebWorkers: true,
        maxWorkers: 2
      });
    }
    return zipModule;
  } catch (e) {
    try {
      zipModule = await import('https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.7.53/+esm');
      if (zipModule && zipModule.configure) {
        zipModule.configure({
          useWebWorkers: true,
          maxWorkers: 2
        });
      }
      return zipModule;
    } catch (err) {
      throw new Error(`Failed to load @zip.js/zip.js: ${err.message}`);
    }
  }
}

let fflateModule = null;

async function getFflateEngine() {
  if (fflateModule) return fflateModule;
  if (typeof window !== 'undefined' && window.fflate) return window.fflate;
  try {
    fflateModule = await import('fflate');
    return fflateModule;
  } catch (e) {
    try {
      fflateModule = await import('https://cdn.jsdelivr.net/npm/fflate@0.8.2/+esm');
      return fflateModule;
    } catch (err) {
      return null;
    }
  }
}

/**
 * Compresses multiple files into a single ZIP with progress tracking and RAM cleanup.
 * @param {File[]|Blob[]} fileList - Array of files to compress
 * @param {Function} onProgress - Callback returning the current percentage (0-100)
 */
export async function createZipArchiveFflate(fileList, onProgress = () => {}) {
  const fflate = await getFflateEngine();
  if (!fflate) {
    return createZipArchiveStreaming(fileList, onProgress);
  }

  return new Promise((resolve, reject) => {
    const archiveData = {};
    let filesProcessed = 0;
    const files = Array.isArray(fileList) ? fileList : [fileList];
    const totalFiles = files.length;

    if (totalFiles === 0) {
      return resolve(new Blob([], { type: 'application/zip' }));
    }

    const handleBuffer = (file, buf) => {
      const name = file.name || `file_${Date.now()}`;
      archiveData[name] = new Uint8Array(buf);
      filesProcessed++;

      const readPercent = Math.round((filesProcessed / totalFiles) * 50);
      if (onProgress) onProgress(readPercent);

      if (filesProcessed === totalFiles) {
        fflate.zip(archiveData, { level: 6 }, (err, out) => {
          if (err) {
            for (const key in archiveData) delete archiveData[key];
            reject(err);
            return;
          }

          if (onProgress) onProgress(100);

          const zipBlob = new Blob([out.buffer], { type: 'application/zip' });
          for (const key in archiveData) {
            delete archiveData[key];
          }

          resolve(zipBlob);
        });
      }
    };

    // 1. Read files and prepare structure
    files.forEach(file => {
      if (file && file.buffer) {
        handleBuffer(file, file.buffer);
        return;
      }

      const reader = new FileReader();
      reader.onload = () => handleBuffer(file, reader.result);
      reader.onerror = () => {
        for (const key in archiveData) delete archiveData[key];
        reject(reader.error);
      };
      reader.readAsArrayBuffer(file);
    });
  });
}

/**
 * Streaming zip.js fallback archiver with buffered chunk writes
 */
export async function createZipArchiveStreaming(files, onProgress = () => {}) {
  const zip = await getZipEngine();
  const zipFileWriter = new zip.BlobWriter('application/zip');
  const zipWriter = new zip.ZipWriter(zipFileWriter, { bufferedWrite: true });

  const totalBytes = files.reduce((acc, f) => acc + (f.size || 0), 0) || 1;
  let processedBytes = 0;

  for (const file of files) {
    const filename = file.name || `file_${Date.now()}`;
    const fileReader = new zip.BlobReader(file);

    await zipWriter.add(filename, fileReader, {
      level: 6,
      onprogress: (currentFileProgress) => {
        const currentTotal = processedBytes + currentFileProgress;
        const percent = Math.min(100, Math.round((currentTotal / totalBytes) * 100));
        onProgress(percent, filename);
      }
    });

    processedBytes += (file.size || 0);
  }

  await zipWriter.close();
  return zipFileWriter.getData();
}

/**
 * Universal zip archive creator
 */
export async function createZipArchive(files, onProgress = () => {}) {
  return createZipArchiveFflate(files, onProgress);
}

/**
 * Extract files from a ZIP archive
 * @param {File|Blob} zipBlob - The zip file to unpack
 * @param {Function} onProgress - Callback function(percent, currentFileName)
 * @returns {Promise<Array<{name: string, blob: Blob, size: number}>>}
 */
export async function extractZipArchive(zipBlob, onProgress = () => {}) {
  const zip = await getZipEngine();
  const zipFileReader = new zip.BlobReader(zipBlob);
  const zipReader = new zip.ZipReader(zipFileReader);

  const entries = await zipReader.getEntries();
  const extractedFiles = [];
  let processedCount = 0;

  for (const entry of entries) {
    // Skip empty folder markers
    if (entry.directory) continue;

    const fileBlob = await entry.getData(new zip.BlobWriter(), {
      onprogress: (currentProgress, total) => {
        const filePercent = total ? Math.round((currentProgress / total) * 100) : 50;
        onProgress(filePercent, entry.filename);
      }
    });

    extractedFiles.push({
      name: entry.filename,
      blob: fileBlob,
      size: entry.uncompressedSize
    });

    processedCount++;
  }

  await zipReader.close();
  return extractedFiles;
}

/**
 * Unified Compressor Engine supporting media quantization & zip archiving
 */
export function isLikelyZipFile(file) {
  if (!file) return false;
  const name = (file.name || '').toLowerCase();
  return name.endsWith('.zip') || (file.type && (file.type === 'application/zip' || file.type === 'application/x-zip-compressed'));
}

export class CompressorEngine {
  constructor() {
    this.history = [];
  }

  calculateEstimatedSize(originalBytes, ratioPercent) {
    const factor = (100 - ratioPercent) / 100;
    const estBytes = Math.round(originalBytes * factor);
    return {
      bytes: estBytes,
      formatted: this.formatBytes(estBytes),
      ratioPercent
    };
  }

  formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  async unzip(file, progressCallback = () => {}) {
    if (window.ServerStreamingEngine) {
      try {
        const serverEngine = new window.ServerStreamingEngine({
          onProgress: (p) => progressCallback(p.percent, p)
        });
        return await serverEngine.unzip(file);
      } catch (err) {
        console.warn('[Compressor] Server unzip failed, falling back to in-browser unpacker:', err);
      }
    }

    // In-browser fallback
    const extracted = await extractZipArchive(file, (pct, name) => {
      progressCallback(pct, { percent: pct, stage: `Extracting ${name || 'files'} (${pct}%)...` });
    });
    if (extracted && extracted.length === 1) {
      const outBlob = extracted[0].blob;
      outBlob.serverOutputFileName = extracted[0].name;
      return outBlob;
    } else if (extracted && extracted.length > 1) {
      return await createZipArchive(extracted.map(e => new File([e.blob], e.name)), (pct) => {
        progressCallback(pct, { percent: pct, stage: `Repacking extracted files (${pct}%)...` });
      });
    }
    throw new Error('ZIP archive is empty or could not be extracted');
  }

  async compress(file, ratioPercent = 75, progressCallback = () => {}) {
    const ext = (file.name || '').split('.').pop().toLowerCase();

    // 1. Direct ZIP file extraction (never re-zip an existing zip)
    if (isLikelyZipFile(file)) {
      return this.unzip(file, progressCallback);
    }

    // 2. Image compression via canvas/ImageEngine
    const isImage = ['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'gif'].includes(ext) || (file.type && file.type.startsWith('image/'));
    if (isImage && window.imageEngine) {
      const quality = ratioPercent > 70 ? 'low' : (ratioPercent > 40 ? 'high' : 'ultra');
      return window.imageEngine.convert(file, ext === 'jpg' ? 'jpg' : 'webp', { quality }, (pct) => {
        const p = typeof pct === 'number' ? pct : (pct && pct.percent) || 0;
        progressCallback(p, { percent: p, stage: 'Compressing image...' });
      });
    }

    // 3. Media detection (video / audio)
    const mediaExts = [
      'mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'm4v', '3gp', 'ts', 'ogv',
      'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'aiff'
    ];
    const isMedia = mediaExts.includes(ext) || (file.type && (file.type.startsWith('video/') || file.type.startsWith('audio/')));

    // 4. Large files or server available: delegate to /api/compress (auto-detects media vs zip)
    if (window.ServerStreamingEngine && (window.ServerStreamingEngine.shouldUseServerEngine(file) || !isMedia)) {
      try {
        const serverEngine = new window.ServerStreamingEngine({
          onProgress: (p) => {
            progressCallback(p.percent, p);
          }
        });
        return await serverEngine.compress(file, { ratioPercent, mode: isMedia ? 'auto' : 'force-zip' });
      } catch (serverErr) {
        console.warn('[Compressor] Server compression failed or unreachable:', serverErr);
        if (!isMedia) {
          // In-browser fallback: streaming zip archiver
          progressCallback(10, { percent: 10, stage: 'Packaging into in-browser ZIP...' });
          return await createZipArchive([file], (pct) => progressCallback(pct, { percent: pct, stage: `Packaging ZIP archive (${pct}%)...` }));
        }
      }
    }

    // 5. Non-media files (e.g. .exe, .pdf, .iso, documents) compressed via in-browser ZIP
    if (!isMedia) {
      return createZipArchive([file], (pct, name) => progressCallback(pct, { percent: pct, stage: `Packaging into ZIP archive (${pct}%)...` }));
    }

    // 6. In-browser FFmpeg for smaller media files (<= 500MB)
    if (!window.ffmpegBridge) {
      throw new Error('FFmpeg is not ready. Wait a moment and try again.');
    }
    return window.ffmpegBridge.compress(file, ratioPercent, (p) => {
      const pct = typeof p === 'object' ? (typeof p.rawPercent === 'number' ? p.rawPercent : p.percent) : p;
      progressCallback(pct, p);
    });
  }

  async compressVideo(file, progressCallback = () => {}) {
    return compressVideo(file, progressCallback);
  }

  async createZipArchive(files, onProgress) {
    return createZipArchive(files, onProgress);
  }

  async extractZipArchive(zipBlob, onProgress) {
    return extractZipArchive(zipBlob, onProgress);
  }
}

/**
 * Direct video compression with virtual memory deletion to prevent black screen crashes
 */
export async function compressVideo(file, progressCallback = () => {}) {
  try {
    if (window.ffmpegBridge) {
      return await window.ffmpegBridge.compress(file, 75, progressCallback);
    }
    throw new Error('FFmpeg bridge is not initialized.');
  } catch (error) {
    console.error("Compression crashed:", error);
    if (typeof alert === 'function') {
      alert("Compression failed. The file is too large for the current memory limit.");
    }
    throw error;
  }
}

if (typeof window !== 'undefined') {
  window.createZipArchive = createZipArchive;
  window.extractZipArchive = extractZipArchive;
  window.compressVideo = compressVideo;
  window.CompressorEngine = CompressorEngine;
  window.compressorEngine = new CompressorEngine();
  window.isLikelyZipFile = isLikelyZipFile;
}
