/**
 * LAS CONVERT — Unified Media Conversion Engine Core
 * Orchestrates tasks, queues, workers, and delegates to specialized sub-engines.
 */

class ConversionEngine {
  constructor() {
    this.queue = [];
    this.activeTasks = new Map();
    this.maxConcurrent = 4;
    this.isProcessing = false;
    this.listeners = new Map();
    this.stats = {
      totalConverted: 0,
      bytesSaved: 0,
      speedSum: 0,
      tasksFinished: 0
    };
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(cb => {
        try { cb(data); } catch (e) { console.error(e); }
      });
    }
  }

  addToQueue(file, options = {}) {
    const taskId = 'task_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now();
    const task = {
      id: taskId,
      file: file,
      name: file.name || 'unnamed_media',
      size: file.size || 0,
      type: this.detectFileType(file),
      targetFormat: options.targetFormat || 'mp4',
      preset: options.preset || 'high',
      options: options,
      status: 'queued', // queued, processing, completed, error, cancelled
      progress: 0,
      speed: '0x',
      error: null,
      outputBlob: null,
      outputName: this.generateOutputName(file.name, options.targetFormat || 'mp4'),
      createdAt: new Date()
    };

    this.queue.push(task);
    this.emit('queueUpdated', this.queue);
    this.emit('log', { level: 'info', message: `Added to queue: ${task.name} → .${task.targetFormat}` });
    
    if (options.autoStart) {
      this.processQueue();
    }

    return task;
  }

  detectFileType(file) {
    const ext = (file.name || '').split('.').pop().toLowerCase();
    if (['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', '3gp'].includes(ext) || (file.type && file.type.startsWith('video/'))) {
      return 'video';
    }
    if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'opus', 'm4a', 'wma'].includes(ext) || (file.type && file.type.startsWith('audio/'))) {
      return 'audio';
    }
    if (['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'bmp', 'svg', 'ico', 'tiff'].includes(ext) || (file.type && file.type.startsWith('image/'))) {
      return 'image';
    }
    return 'file';
  }

  generateOutputName(origName, targetFmt) {
    const base = (origName || 'output').replace(/\.[^/.]+$/, '');
    return `${base}_converted.${targetFmt.toLowerCase()}`;
  }

  async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.hasPendingTasks()) {
      const availableSlots = this.maxConcurrent - this.activeTasks.size;
      if (availableSlots <= 0) {
        await new Promise(r => setTimeout(r, 200));
        continue;
      }

      const nextTask = this.queue.find(t => t.status === 'queued');
      if (!nextTask) break;

      this.runTask(nextTask);
    }

    this.isProcessing = false;
  }

  hasPendingTasks() {
    return this.queue.some(t => t.status === 'queued') || this.activeTasks.size > 0;
  }

  async runTask(task) {
    task.status = 'processing';
    this.activeTasks.set(task.id, task);
    this.emit('taskStarted', task);
    this.emit('log', { level: 'info', message: `[WORKER] Starting transcode for ${task.name}` });

    try {
      let resultBlob = null;

      // Delegate to appropriate specialized core module
      const isAudioTarget = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'opus', 'm4a'].includes((task.targetFormat || '').toLowerCase());

      // Route large files (> 500MB) directly to native server streaming engine (bypasses 2GB WASM ceiling)
      if (window.ServerStreamingEngine && window.ServerStreamingEngine.shouldUseServerEngine(task.file)) {
        this.emit('log', { level: 'info', message: `[SERVER STREAM] Routing ${(task.size / (1024*1024*1024)).toFixed(2)} GB file to native server engine.` });
        const serverEngine = new window.ServerStreamingEngine({
          onProgress: (p) => {
            this.updateProgress(task, p);
          }
        });
        resultBlob = await serverEngine.convert(task.file, {
          targetFormat: task.targetFormat,
          ...task.options
        });
      } else if (task.type === 'video' && isAudioTarget && window.audioEngine) {
        resultBlob = await window.audioEngine.extractAudioFromVideo(task.file, task.targetFormat, task.options, (p) => {
          this.updateProgress(task, p);
        });
      } else if (task.type === 'image' && window.imageEngine) {
        resultBlob = await window.imageEngine.convert(task.file, task.targetFormat, task.options, (p) => {
          this.updateProgress(task, p);
        });
      } else if (task.type === 'audio' && window.audioEngine) {
        resultBlob = await window.audioEngine.convert(task.file, task.targetFormat, task.options, (p) => {
          this.updateProgress(task, p);
        });
      } else if (task.type === 'video' && window.videoEngine) {
        resultBlob = await window.videoEngine.convert(task.file, task.targetFormat, task.options, (p) => {
          this.updateProgress(task, p);
        });
      } else if ((task.targetFormat || '').toLowerCase() === 'zip') {
        resultBlob = await this.wrapAsZip(task);
      } else {
        // No real converter for this combination: fail loudly instead of
        // producing a fake output file.
        throw this.unsupportedConversionError(task);
      }

      if (!resultBlob || !resultBlob.size) {
        throw new Error('Conversion produced an empty file.');
      }
      task.outputBlob = resultBlob;
      task.status = 'completed';
      task.progress = 100;
      
      // Update global telemetry statistics
      this.stats.totalConverted++;
      this.stats.tasksFinished++;
      const saved = Math.max(0, (task.size - (resultBlob ? resultBlob.size : task.size * 0.8)));
      this.stats.bytesSaved += saved;

      if (window.historyEngine) {
        window.historyEngine.record({
          name: task.name,
          inputSize: task.size,
          outputSize: resultBlob ? resultBlob.size : task.size * 0.75,
          targetFormat: task.targetFormat,
          status: 'Success'
        });
      }

      this.emit('taskCompleted', task);
      this.emit('log', { level: 'success', message: `[WORKER] Finished ${task.outputName} (${(resultBlob.size / (1024*1024)).toFixed(2)} MB)` });
    } catch (err) {
      console.error(err);
      task.status = 'error';
      task.error = err.message || 'Conversion failed';
      this.emit('taskError', task);
      this.emit('log', { level: 'error', message: `[WORKER ERROR] ${task.name}: ${task.error}` });
    } finally {
      this.activeTasks.delete(task.id);
      this.emit('queueUpdated', this.queue);
      this.processQueue();
    }
  }

  updateProgress(task, progressVal) {
    let pct = 0;
    let stage = '';
    if (typeof progressVal === 'object' && progressVal !== null) {
      pct = typeof progressVal.percent === 'number' ? progressVal.percent : (progressVal.progress || 0);
      stage = progressVal.stage || '';
    } else {
      pct = Number(progressVal) || 0;
    }
    task.progress = Math.min(100, Math.max(0, Math.round(pct)));
    if (stage) task.stage = stage;
    this.emit('taskProgress', task);
  }

  async wrapAsZip(task) {
    if (typeof window.createZipArchive !== 'function') {
      throw new Error('ZIP engine is not loaded yet. Wait a moment and try again.');
    }
    this.updateProgress(task, { percent: 10, stage: 'Packaging into ZIP archive...' });
    return window.createZipArchive([task.file], (pct) => {
      this.updateProgress(task, { percent: pct, stage: `Packaging into ZIP archive (${pct}%)...` });
    });
  }

  unsupportedConversionError(task) {
    const fmt = (task.targetFormat || '').toLowerCase();
    const kind = task.type === 'file' ? 'this file type' : `${task.type} files`;
    return new Error(`Converting ${kind} (${task.name}) to .${fmt} is not supported. ` +
      'Pick a video/audio/image target format, or ZIP to archive the file.');
  }

  cancelTask(taskId) {
    const task = this.queue.find(t => t.id === taskId);
    if (task) {
      task.status = 'cancelled';
      this.activeTasks.delete(taskId);
      this.emit('taskCancelled', task);
      this.emit('queueUpdated', this.queue);
      this.emit('log', { level: 'warn', message: `Cancelled conversion for ${task.name}` });
    }
  }

  clearCompleted() {
    this.queue = this.queue.filter(t => t.status !== 'completed' && t.status !== 'cancelled');
    this.emit('queueUpdated', this.queue);
  }
}

window.conversionEngine = new ConversionEngine();
