// server/archive-engine.js
//
// General-purpose streaming file archiver and extractor.
// Compresses or extracts ANY file or set of files via ZIP without RAM limits.

const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
const { resolveInside } = require('./security');

// archiver@8 is an ES module. Node >= 22.12 can require() it, but older
// runtimes (e.g. the Node bundled with Electron 28) cannot, so fall back to a
// dynamic import() and load it lazily.
let archiverPromise = null;
function loadArchiver() {
  if (!archiverPromise) {
    archiverPromise = (async () => {
      let mod;
      try {
        mod = require('archiver');
      } catch (e) {
        if (e.code !== 'ERR_REQUIRE_ESM' && e.code !== 'ERR_REQUIRE_ASYNC_MODULE') throw e;
        mod = await import('archiver');
      }
      return mod;
    })();
  }
  return archiverPromise;
}

async function createZipArchiveInstance(options = { zlib: { level: 6 } }) {
  const mod = await loadArchiver();
  const candidates = [mod, mod && mod.default].filter(Boolean);
  for (const archiver of candidates) {
    if (typeof archiver === 'function') return archiver('zip', options);
    if (archiver.ZipArchive) return new archiver.ZipArchive(options);
    if (typeof archiver.create === 'function') return archiver.create('zip', options);
    if (archiver.Archiver) return new archiver.Archiver('zip', options);
  }
  throw new Error('Unsupported archiver module format');
}

/**
 * Zip a single file (or array of files) into one .zip archive, streaming
 * both the read and write so large files don't blow up memory.
 *
 * @param {Array<string|{path: string, name?: string}>} inputPaths - absolute paths of files to
 *   include, or { path, name } objects to store a file under a different entry name
 * @param {string} outputZipPath - where to write the resulting .zip
 * @param {(percent: number) => void} onProgress - called with 0-100
 * @returns {Promise<{ outputPath: string, originalSize: number, compressedSize: number }>}
 */
async function zipFiles(inputPaths, outputZipPath, onProgress = () => {}) {
  const inputs = inputPaths.map((p) => (typeof p === 'string' ? { path: p, name: path.basename(p) } : { path: p.path, name: p.name || path.basename(p.path) }));
  const archive = await createZipArchiveInstance({
    zlib: { level: 6 }, // Balanced compression
  });
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    try {
      totalBytes = inputs.reduce((sum, f) => sum + (fs.existsSync(f.path) ? fs.statSync(f.path).size : 0), 0);
    } catch (e) {
      totalBytes = 0;
    }

    const output = fs.createWriteStream(outputZipPath);

    let bytesArchived = 0;

    archive.on('entry', (entry) => {
      bytesArchived += entry.stats?.size || 0;
      if (totalBytes > 0) {
        const percent = Math.min(99, Math.round((bytesArchived / totalBytes) * 100));
        onProgress(percent);
      }
    });

    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') reject(err);
    });

    archive.on('error', reject);

    output.on('close', () => {
      onProgress(100);
      resolve({
        outputPath: outputZipPath,
        originalSize: totalBytes,
        compressedSize: archive.pointer(),
      });
    });

    archive.pipe(output);

    for (const f of inputs) {
      if (fs.existsSync(f.path)) {
        archive.file(f.path, { name: f.name });
      }
    }

    archive.finalize();
  });
}

/**
 * Zip an entire directory (recursively) into one .zip archive.
 */
async function zipDirectory(sourceDir, outputZipPath, onProgress = () => {}) {
  const archive = await createZipArchiveInstance({ zlib: { level: 6 } });
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputZipPath);

    let entriesProcessed = 0;
    let totalEntries = 0;

    const countFiles = (dir) => {
      let count = 0;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        count += entry.isDirectory() ? countFiles(fullPath) : 1;
      }
      return count;
    };

    try {
      totalEntries = countFiles(sourceDir);
    } catch (e) {
      totalEntries = 1;
    }

    archive.on('entry', () => {
      entriesProcessed += 1;
      if (totalEntries > 0) {
        onProgress(Math.min(99, Math.round((entriesProcessed / totalEntries) * 100)));
      }
    });

    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') reject(err);
    });
    archive.on('error', reject);

    output.on('close', () => {
      onProgress(100);
      resolve({ outputPath: outputZipPath, compressedSize: archive.pointer() });
    });

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

/**
 * Extract a .zip archive into a target directory, streaming entry by
 * entry so large archives don't need to be fully buffered in memory.
 *
 * Zip-slip safe: every entry path is resolved against `outputDir` and the
 * whole extraction is aborted if any entry would land outside of it
 * (absolute paths, drive letters, `..` traversal, NUL bytes).
 *
 * Resolves only after every extracted file has been fully flushed to disk.
 *
 * @param {string} zipPath
 * @param {string} outputDir
 * @param {(percent: number) => void} onProgress
 * @param {{ maxEntries?: number, maxTotalBytes?: number }} limits - zip-bomb guards
 */
function unzipFile(zipPath, outputDir, onProgress = () => {}, limits = {}) {
  const maxEntries = limits.maxEntries || 10000;
  const maxTotalBytes = limits.maxTotalBytes || 20 * 1024 * 1024 * 1024; // 20 GB

  return new Promise((resolve, reject) => {
    fs.mkdirSync(outputDir, { recursive: true });
    const baseDir = path.resolve(outputDir);

    const extractedFiles = [];
    const pendingWrites = [];
    let entryCount = 0;
    let totalBytes = 0;
    let failed = false;

    const source = fs.createReadStream(zipPath);
    const parser = unzipper.Parse();

    const fail = (err) => {
      if (failed) return;
      failed = true;
      source.destroy();
      parser.destroy();
      reject(err);
    };

    parser.on('entry', (entry) => {
      if (failed) {
        entry.autodrain();
        return;
      }

      entryCount += 1;
      if (entryCount > maxEntries) {
        entry.autodrain();
        fail(new Error(`Archive has too many entries (limit ${maxEntries}).`));
        return;
      }

      const destPath = resolveInside(baseDir, entry.path);
      if (!destPath) {
        entry.autodrain();
        fail(new Error(`Unsafe path in archive rejected: ${JSON.stringify(entry.path)}`));
        return;
      }

      if (entry.type === 'Directory') {
        fs.mkdirSync(destPath, { recursive: true });
        entry.autodrain();
        return;
      }

      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const out = fs.createWriteStream(destPath, { flags: 'wx' });
      entry.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > maxTotalBytes) {
          fail(new Error('Archive expands beyond the allowed size limit.'));
        }
      });
      pendingWrites.push(new Promise((res, rej) => {
        out.on('finish', res);
        out.on('error', rej);
        entry.on('error', rej);
      }));
      entry.pipe(out);
      extractedFiles.push(path.relative(baseDir, destPath).split(path.sep).join('/'));
    });

    parser.on('close', () => {
      if (failed) return;
      Promise.all(pendingWrites)
        .then(() => {
          onProgress(100);
          resolve({ outputDir: baseDir, extractedFiles });
        })
        .catch(fail);
    });
    parser.on('error', fail);
    source.on('error', fail);

    source.pipe(parser);
  });
}

/**
 * Quick check: does this file look like a valid zip archive (for the
 * unzip path), based on the local file header magic bytes ("PK\x03\x04")?
 */
function isValidZip(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(4);
    fs.readSync(fd, buffer, 0, 4, 0);
    fs.closeSync(fd);
    return buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07);
  } catch (e) {
    return false;
  }
}

module.exports = { zipFiles, zipDirectory, unzipFile, isValidZip };
