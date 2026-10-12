// server/binaries.js
//
// Resolve the native ffmpeg / ffprobe executables used by the local servers
// and the Electron main process. Order: FFMPEG_PATH / FFPROBE_PATH env var,
// then the bundled @ffmpeg-installer / @ffprobe-installer binary, then PATH.

const fs = require('fs');

// Inside a packaged Electron app the installer binaries live in
// app.asar.unpacked (see "asarUnpack" in package.json); asar paths cannot be executed.
function unpackedAsarPath(p) {
  if (!p) return p;
  const unpacked = p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  return unpacked !== p && fs.existsSync(unpacked) ? unpacked : p;
}

function resolveBinary(envVar, installerModule, fallback) {
  if (process.env[envVar]) return process.env[envVar];
  try {
    const installer = require(installerModule);
    const p = installer && unpackedAsarPath(installer.path);
    if (p && fs.existsSync(p)) return p;
  } catch (e) {
    // installer package missing for this platform -> fall back to PATH
  }
  return fallback;
}

const FFMPEG_PATH = resolveBinary('FFMPEG_PATH', '@ffmpeg-installer/ffmpeg', 'ffmpeg');
const FFPROBE_PATH = resolveBinary('FFPROBE_PATH', '@ffprobe-installer/ffprobe', 'ffprobe');

module.exports = { FFMPEG_PATH, FFPROBE_PATH };
