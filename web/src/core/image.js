/**
 * LAS CONVERT — Image Processing Core Engine
 * Client-side high fidelity image conversion, compression, and format encoding using HTML5 Canvas & WebCodecs.
 */

class ImageEngine {
  constructor() {
    this.supportedFormats = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'ico'];
  }

  async convert(file, targetFormat = 'webp', options = {}, progressCallback = () => {}) {
    progressCallback(20);

    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);

      img.onload = () => {
        progressCallback(50);
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        if (options.resolution === '720p' && width > 1280) {
          height = Math.round((height * 1280) / width);
          width = 1280;
        } else if (options.resolution === '480p' && width > 854) {
          height = Math.round((height * 854) / width);
          width = 854;
        }

        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        progressCallback(80);

        const quality = options.quality === 'ultra' ? 0.95 : (options.quality === 'low' ? 0.4 : 0.8);
        const mimeMap = {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          webp: 'image/webp',
          avif: 'image/avif',
          bmp: 'image/bmp',
          ico: 'image/x-icon'
        };

        const targetMime = mimeMap[targetFormat.toLowerCase()];
        if (!targetMime) {
          URL.revokeObjectURL(url);
          reject(new Error(`Unsupported image output format: ${targetFormat}`));
          return;
        }

        const fmt = targetFormat.toLowerCase();
        if (fmt === 'bmp' || fmt === 'ico') {
          try {
            const blob = fmt === 'bmp' ? ImageEngine.encodeBmp(ctx, width, height) : null;
            if (blob) { URL.revokeObjectURL(url); progressCallback(100); resolve(blob); return; }
            // ICO: PNG-in-ICO, scaled to fit 256x256.
            const s = Math.min(256, Math.max(width, height));
            const ic = document.createElement('canvas'); ic.width = s; ic.height = s;
            const r = Math.min(s / width, s / height);
            ic.getContext('2d').drawImage(canvas, (s - width * r) / 2, (s - height * r) / 2, width * r, height * r);
            ic.toBlob(async (png) => {
              URL.revokeObjectURL(url);
              if (!png) { reject(new Error('Failed to encode ICO')); return; }
              const pngBuf = new Uint8Array(await png.arrayBuffer());
              const head = new DataView(new ArrayBuffer(22));
              head.setUint16(2, 1, true); head.setUint16(4, 1, true);
              head.setUint8(6, s >= 256 ? 0 : s); head.setUint8(7, s >= 256 ? 0 : s);
              head.setUint16(10, 1, true); head.setUint16(12, 32, true);
              head.setUint32(14, pngBuf.length, true); head.setUint32(18, 22, true);
              progressCallback(100);
              resolve(new Blob([head.buffer, pngBuf], { type: 'image/x-icon' }));
            }, 'image/png');
          } catch (e) { URL.revokeObjectURL(url); reject(e); }
          return;
        }

        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          progressCallback(100);
          // Browsers silently fall back to PNG for MIME types the canvas
          // cannot encode (e.g. BMP, ICO, often AVIF). Refuse instead of
          // returning a PNG (or an empty buffer) under the wrong extension.
          if (blob && blob.size > 0 && blob.type === targetMime) {
            resolve(blob);
          } else {
            reject(new Error(`This browser cannot encode ${targetFormat.toUpperCase()} images. Choose PNG, JPG or WEBP instead.`));
          }
        }, targetMime, quality);
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to decode image file'));
      };

      img.src = url;
    });
  }
}

ImageEngine.encodeBmp = function encodeBmp(ctx, w, h) {
  const px = ctx.getImageData(0, 0, w, h).data;
  const row = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + row * h;
  const b = new DataView(new ArrayBuffer(size));
  b.setUint8(0, 0x42); b.setUint8(1, 0x4d); b.setUint32(2, size, true); b.setUint32(10, 54, true);
  b.setUint32(14, 40, true); b.setInt32(18, w, true); b.setInt32(22, h, true);
  b.setUint16(26, 1, true); b.setUint16(28, 24, true); b.setUint32(34, row * h, true);
  for (let y = 0; y < h; y++) {
    const o = 54 + (h - 1 - y) * row;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      b.setUint8(o + x * 3, px[i + 2]); b.setUint8(o + x * 3 + 1, px[i + 1]); b.setUint8(o + x * 3 + 2, px[i]);
    }
  }
  return new Blob([b.buffer], { type: 'image/bmp' });
};

window.imageEngine = new ImageEngine();
