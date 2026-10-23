/**
 * Download the official standalone yt-dlp binary into resources/bin so the
 * packaged desktop app ships with it (electron-builder "extraResources").
 *   node build-scripts/fetch-ytdlp.js [--platform win32|linux|darwin]
 * At runtime the app copies it to its user-data dir and self-updates it daily.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const i = process.argv.indexOf('--platform');
const platform = i > 0 ? process.argv[i + 1] : process.platform;
const asset = platform === 'win32' ? 'yt-dlp.exe' : platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';
const outName = platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const outDir = path.join(__dirname, '..', 'resources', 'bin');
fs.mkdirSync(outDir, { recursive: true });
const dest = path.join(outDir, outName);
// LAS_YTDLP_CHANNEL=nightly bundles yt-dlp's nightly build instead of the stable release.
const repo = process.env.LAS_YTDLP_CHANNEL === 'nightly' ? 'yt-dlp/yt-dlp-nightly-builds' : 'yt-dlp/yt-dlp';

let attempt = 0;
function retry(why) {
  if (++attempt > 6) { console.error(why + ' (giving up)'); process.exit(1); }
  console.error(why + ` - retry ${attempt}/6`);
  setTimeout(() => get(`https://github.com/${repo}/releases/latest/download/${asset}`), 3000 * attempt);
}
function get(url, n = 6) {
  https.get(url, { headers: { 'User-Agent': 'LAS-CONVERT-build' } }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && n > 0) {
      res.resume();
      return get(new URL(res.headers.location, url).toString(), n - 1);
    }
    if (res.statusCode !== 200) { res.resume(); return retry(`HTTP ${res.statusCode} for ${url}`); }
    const out = fs.createWriteStream(dest, { mode: 0o755 });
    res.pipe(out);
    out.on('finish', () => out.close(() => console.log(`yt-dlp (${asset}) -> ${dest} (${fs.statSync(dest).size} bytes)`)));
  }).on('error', (e) => retry(e.message));
}
get(`https://github.com/${repo}/releases/latest/download/${asset}`);

// deno: JS runtime yt-dlp needs to solve YouTube's JS challenges (EJS).
const denoAsset = platform === 'win32' ? 'deno-x86_64-pc-windows-msvc.zip'
  : platform === 'darwin' ? 'deno-aarch64-apple-darwin.zip' : 'deno-x86_64-unknown-linux-gnu.zip';
const denoName = platform === 'win32' ? 'deno.exe' : 'deno';
function getBuf(url, n = 6) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'LAS-CONVERT-build' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && n > 0) {
        res.resume();
        return getBuf(new URL(res.headers.location, url).toString(), n - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}
(async () => {
  const unzipper = require('unzipper');
  const zip = await getBuf(`https://github.com/denoland/deno/releases/latest/download/${denoAsset}`);
  const dir = await unzipper.Open.buffer(zip);
  const entry = dir.files.find((f) => f.path === denoName);
  if (!entry) throw new Error(`${denoName} not found in ${denoAsset}`);
  const d = path.join(outDir, denoName);
  fs.writeFileSync(d, await entry.buffer(), { mode: 0o755 });
  console.log(`deno (${denoAsset}) -> ${d} (${fs.statSync(d).size} bytes)`);
})().catch((e) => { console.error(`deno download failed: ${e.message}`); process.exit(1); });
