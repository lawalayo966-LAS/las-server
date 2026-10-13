class PlatformBridge {
  constructor() {
    this.currentPlatform = this.detectPlatform();
    this.capabilities = this.resolveCapabilities();
  }

  detectPlatform() {
    if (typeof window !== 'undefined' && window.electronAPI) return 'windows';
    const isAndroid = typeof window !== 'undefined' && (window.Capacitor || navigator.userAgent.toLowerCase().includes('android'));
    if (isAndroid) return 'android';
    if (typeof window !== 'undefined' && (window.__LAS_IOS_ENVIRONMENT__ || location.search.includes('target=ios') || /iphone|ipad|ipod/i.test(navigator.userAgent))) return 'ios';
    return 'windows';
  }

  resolveCapabilities() {
    return {
      windows: {
        name: 'WINDOWS BUILD (.EXE)',
        version: 'v1.0.0-PRO',
        icon: 'fa-brands fa-windows',
        description: 'Native Windows executable & setup installer'
      },
      android: {
        name: 'ANDROID BUILD (.APK)',
        version: 'v1.0.0-APK',
        icon: 'fa-brands fa-android',
        description: 'Touch-optimized Android package'
      },
      ios: {
        name: 'IPHONE BUILD (.IPA)',
        version: 'v1.0.0-IOS',
        icon: 'fa-brands fa-apple',
        description: 'iPhone Home Screen / IPA package'
      }
    };
  }

  getPlatformInfo(platformKey = this.currentPlatform) {
    return this.capabilities[platformKey] || this.capabilities.windows;
  }

  setPlatform(platformKey) {
    if (this.capabilities[platformKey]) {
      this.currentPlatform = platformKey;
      return true;
    }
    return false;
  }

  extFilters(filename) {
    const ext = String(filename || 'bin').split('.').pop().toLowerCase();
    return [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All files', extensions: ['*'] }];
  }

  /**
   * Prompt where to save BEFORE converting
   */
  async chooseSavePath(filename) {
    const suggested = filename || 'output.bin';
    if (window.electronAPI && window.electronAPI.chooseSavePath) {
      return window.electronAPI.chooseSavePath({
        title: 'Choose where to save converted file',
        defaultPath: suggested,
        filters: this.extFilters(suggested)
      });
    }

    // Website: save straight to the browser's Downloads (no picker or prompt;
    // mobile browsers have no save picker, and a prompt per file is clumsy).
    if (!window.Capacitor && /^https?:$/.test(window.location.protocol)) return '__download__';

    if (window.showSaveFilePicker) {
      try {
        const ext = suggested.split('.').pop();
        const handle = await window.showSaveFilePicker({
          suggestedName: suggested,
          types: [{ description: ext.toUpperCase() + ' File', accept: { 'application/octet-stream': ['.' + ext] } }]
        });
        return handle;
      } catch (err) {
        if (err && err.name === 'AbortError') return null;
      }
    }

    // Modern browser prompt for filename/destination
    const userChoice = window.prompt('Where would you like to save this converted file? (Enter filename)', suggested);
    if (userChoice === null) return null;
    return userChoice.trim() || suggested;
  }

  async writeToDestination(dest, blob, filename) {
    if (!dest) return null;
    if (dest === '__download__') {
      this.saveFile(blob, filename);
      return filename;
    }
    if (typeof dest === 'string' && !window.electronAPI) {
      this.saveFile(blob, dest || filename);
      return dest || filename;
    }
    if (typeof dest === 'string' && window.electronAPI) {
      const ab = await blob.arrayBuffer();
      await window.electronAPI.writeFile(dest, ab);
      return dest;
    }
    if (dest && dest.createWritable) {
      const writable = await dest.createWritable();
      await writable.write(blob);
      await writable.close();
      return dest.name || filename;
    }
    this.saveFile(blob, filename);
    return filename;
  }

  async saveFileAs(blob, filename) {
    const dest = await this.chooseSavePath(filename);
    if (!dest) return null;
    return await this.writeToDestination(dest, blob, filename);
  }

  saveFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  /**
   * Download real release binary for Windows (.EXE), Android (.APK), or iPhone (.IPA)
   */


  async hasNativeFfmpeg() {
    if (window.electronAPI && typeof window.electronAPI.hasNativeFfmpeg === 'function') {
      try {
        return await window.electronAPI.hasNativeFfmpeg();
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  async nativeConvert(opts) {
    if (window.electronAPI && typeof window.electronAPI.nativeConvert === 'function') {
      return await window.electronAPI.nativeConvert(opts);
    }
    throw new Error('Native FFmpeg conversion is only available in the packaged desktop version.');
  }
}

window.platformBridge = new PlatformBridge();

