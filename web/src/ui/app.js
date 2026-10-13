/**
 * LAS CONVERT — Master Application UI Controller
 * Wires all 15 navigation views, drag & drop dropzones, audio visualizers,
 * interactive sliders, telemetry meters, and release package modals.
 */

document.addEventListener('DOMContentLoaded', () => {
  // Universal safe file reader for Error: File could not be read! Code=-1 prevention
  async function safelyReadFile(fileInputEvent) {
    if (typeof window !== 'undefined' && window.safelyReadFile) {
      return await window.safelyReadFile(fileInputEvent);
    }
    try {
      const file = (fileInputEvent && fileInputEvent.target && fileInputEvent.target.files)
        ? fileInputEvent.target.files[0]
        : (fileInputEvent && fileInputEvent.dataTransfer && fileInputEvent.dataTransfer.files)
        ? fileInputEvent.dataTransfer.files[0]
        : fileInputEvent;

      if (!file) throw new Error("No file selected.");

      // CRITICAL: Bypass FileReader completely for large files (> 20MB) or video/audio streams.
      // FileReader loads the entire file into a single ArrayBuffer (reader.result), instantly shattering
      // JavaScript heap limits and crashing the browser on 3GB files.
      // By passing the raw File handle directly, fetchFile() streams the file in chunks into FFmpeg safely.
      const isLargeOrMedia = file.size > 20 * 1024 * 1024 || (file.type && (file.type.startsWith('video/') || file.type.startsWith('audio/')));
      if (isLargeOrMedia) {
        console.log(`[STREAMING] Bypassing FileReader for ${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB). Streaming directly via raw File handle.`);
        return {
          name: file.name,
          size: file.size,
          type: file.type || 'application/octet-stream',
          buffer: null,
          file: file,
          blob: file,
          isStreamHandle: true
        };
      }

      // Method 1: Using standard FileReader only for small non-media files
      const arrayBuffer = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = (error) => reject(error);
        reader.readAsArrayBuffer(file);
      });

      console.log("File successfully read into memory, size:", arrayBuffer.byteLength);

      let safeFile;
      try {
        safeFile = new File([arrayBuffer], file.name || 'file.bin', {
          type: file.type || 'application/octet-stream',
          lastModified: file.lastModified || Date.now()
        });
      } catch (e) {
        safeFile = new Blob([arrayBuffer], { type: file.type || 'application/octet-stream' });
        safeFile.name = file.name || 'file.bin';
      }
      safeFile.buffer = arrayBuffer;
      safeFile.rawBuffer = arrayBuffer;

      return {
        name: file.name,
        size: file.size,
        type: file.type,
        buffer: arrayBuffer,
        file: safeFile,
        blob: safeFile
      };

    } catch (error) {
      console.error("File read error (Code=-1 prevention):", error);
      alert("Could not read the file. Please re-select the file and try again.");
      return null;
    }
  }

  async function safelyReadFiles(fileInputEvent) {
    if (typeof window !== 'undefined' && window.safelyReadFiles) {
      return await window.safelyReadFiles(fileInputEvent);
    }
    try {
      const fileList = (fileInputEvent && fileInputEvent.target && fileInputEvent.target.files)
        ? fileInputEvent.target.files
        : (fileInputEvent && fileInputEvent.dataTransfer && fileInputEvent.dataTransfer.files)
        ? fileInputEvent.dataTransfer.files
        : (Array.isArray(fileInputEvent) ? fileInputEvent : [fileInputEvent]);

      if (!fileList || fileList.length === 0) return [];
      const results = [];
      for (let i = 0; i < fileList.length; i++) {
        const res = await safelyReadFile(fileList[i]);
        if (res) results.push(res);
      }
      return results;
    } catch (error) {
      console.error("Batch file read error:", error);
      return [];
    }
  }

  const App = {
    currentCategory: 'video',
    selectedFile: null,
    selectedVaFile: null,
    selectedCompFile: null,
    activeTab: 'dashboard',

    init() {
      this.initNavigation();
      this.initMobileSidebar();
      this.initCollapsibleSidebar();
      this.initDashboard();
      this.initConvertWorkbench();
      this.initVideoAudioWorkbench();
      this.initCompressorWorkbench();
      this.initBatchWorkbench();
      this.initDownloadCenter();
      this.initInspectorWorkbench();
      this.initQuickEditor();
      this.initSubtitlesWorkbench();
      this.initSpeechWorkbench();
      this.initHistoryView();
      this.initSettings();
      this.initGlobalShortcuts();

      this.logTelemetry('[LAS CONVERT] Master UI & Core Engine initialized successfully.', 'success');
    },

    // 1. Navigation & Tab Switching
    initNavigation() {
      const navLinks = document.querySelectorAll('.sidebar-nav .nav-item');
      navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          const tabId = link.getAttribute('data-tab');
          this.switchTab(tabId);
        });
      });

      // Quick Launchpad Tiles on Dashboard
      document.querySelectorAll('.launch-tile').forEach(tile => {
        tile.addEventListener('click', () => {
          const navTab = tile.getAttribute('data-nav');
          const subCat = tile.getAttribute('data-sub');
          this.switchTab(navTab);
          if (subCat && navTab === 'convert') {
            this.switchConvertCategory(subCat);
          }
        });
      });

      // Top Actions
      document.getElementById('btn-quick-queue').addEventListener('click', () => this.switchTab('batch'));
      document.getElementById('btn-global-history').addEventListener('click', () => this.switchTab('history'));
      document.getElementById('btn-global-settings').addEventListener('click', () => this.switchTab('settings'));
      document.getElementById('btn-dash-quick-convert').addEventListener('click', () => this.switchTab('convert'));
    },

    // Gemini-style Collapsible Sidebar (Desktop & Mobile)
    initMobileSidebar() {
      const sidebar = document.querySelector('.sidebar') || document.querySelector('.app-sidebar');
      const backdrop = document.querySelector('.sidebar-backdrop') || document.getElementById('sidebar-backdrop');
      const toggleBtn = document.getElementById('sidebar-toggle-btn') || document.getElementById('btn-mobile-menu');
      const closeBtn = document.getElementById('btn-sidebar-close');

      if (!sidebar) return;

      const closeDrawer = () => {
        sidebar.classList.remove('mobile-open');
        if (backdrop) backdrop.classList.remove('active');
        document.body.style.overflow = '';
      };

      const openDrawer = () => {
        sidebar.classList.add('mobile-open');
        if (backdrop) backdrop.classList.add('active');
        document.body.style.overflow = 'hidden';
      };

      this.closeMobileDrawer = closeDrawer;
      this.openMobileDrawer = openDrawer;

      // Restore saved desktop collapsed state from localStorage
      if (window.innerWidth > 768) {
        const isCollapsed = localStorage.getItem('sidebar-desktop-collapsed') === 'true';
        if (isCollapsed) {
          sidebar.classList.add('collapsed');
          if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
        } else {
          if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
        }
      }

      if (toggleBtn) {
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (window.innerWidth <= 768) {
            // Mobile: slide in / out drawer
            if (sidebar.classList.contains('mobile-open')) {
              closeDrawer();
            } else {
              openDrawer();
            }
          } else {
            // Desktop: collapse/expand like Gemini
            const isCollapsed = sidebar.classList.toggle('collapsed');
            localStorage.setItem('sidebar-desktop-collapsed', String(isCollapsed));
            toggleBtn.setAttribute('aria-expanded', String(!isCollapsed));
          }
        });
      }

      if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          closeDrawer();
        });
      }

      if (backdrop) {
        backdrop.addEventListener('click', () => {
          closeDrawer();
        });
      }

      // Auto-collapse on click: whenever any menu item is clicked on mobile, the sidebar automatically closes
      const menuLinks = sidebar.querySelectorAll('a, button:not(#sidebar-toggle-btn), .nav-item');
      menuLinks.forEach(link => {
        link.addEventListener('click', () => {
          if (window.innerWidth <= 768) {
            closeDrawer();
          }
        });
      });
    },

    // Collapsible Sidebar Sections with Persisted State
    initCollapsibleSidebar() {
      const headers = document.querySelectorAll('.sidebar-section-header');

      headers.forEach((header) => {
        const sectionId = header.dataset.section;
        const body = document.getElementById(sectionId);
        if (!body) return;

        // Restore saved state from localStorage
        const savedState = localStorage.getItem(`sidebar-collapsed:${sectionId}`);
        const isCollapsed = savedState === 'true';
        this.setSidebarSectionState(header, body, isCollapsed, false);

        header.addEventListener('click', () => {
          const currentlyCollapsed = body.classList.contains('collapsed');
          const next = !currentlyCollapsed;
          this.setSidebarSectionState(header, body, next, true);
          localStorage.setItem(`sidebar-collapsed:${sectionId}`, String(next));
        });
      });
    },

    setSidebarSectionState(header, body, collapsed, animate) {
      if (collapsed) {
        if (animate) {
          body.style.maxHeight = body.scrollHeight + 'px';
          requestAnimationFrame(() => {
            body.classList.add('collapsed');
            body.style.maxHeight = '0px';
          });
        } else {
          body.classList.add('collapsed');
          body.style.maxHeight = '0px';
        }
        header.classList.add('collapsed');
        header.setAttribute('aria-expanded', 'false');
      } else {
        body.classList.remove('collapsed');
        header.classList.remove('collapsed');
        header.setAttribute('aria-expanded', 'true');
        body.style.maxHeight = body.scrollHeight + 'px';
        body.addEventListener(
          'transitionend',
          () => {
            if (!body.classList.contains('collapsed')) body.style.maxHeight = 'none';
          },
          { once: true }
        );
      }
    },

    // Media Preview Object URL Management (Prevents Renderer OOM Crashing)
    setMediaPreviewSrc(el, blob) {
      if (!el) return;
      if (el.dataset.objectUrl) {
        try { URL.revokeObjectURL(el.dataset.objectUrl); } catch (_) {}
      }
      if (!blob) {
        el.removeAttribute('src');
        delete el.dataset.objectUrl;
        return;
      }
      const newUrl = URL.createObjectURL(blob);
      el.src = newUrl;
      el.dataset.objectUrl = newUrl;
    },

    cleanupMediaPreview(el) {
      if (!el) return;
      if (el.dataset.objectUrl) {
        try { URL.revokeObjectURL(el.dataset.objectUrl); } catch (_) {}
        delete el.dataset.objectUrl;
      }
      el.removeAttribute('src');
      if (typeof el.load === 'function') el.load();
    },

    switchTab(tabId) {
      this.activeTab = tabId;
      if (window.innerWidth <= 768 && this.closeMobileDrawer) {
        this.closeMobileDrawer();
      }
      document.querySelectorAll('.sidebar-nav .nav-item').forEach(link => {
        link.classList.toggle('active', link.getAttribute('data-tab') === tabId);
      });

      document.querySelectorAll('.tab-view').forEach(view => {
        view.classList.toggle('active', view.id === `view-${tabId}`);
      });

      // Tab specific refresh actions
      if (tabId === 'history') this.renderHistoryTable();
      if (tabId === 'batch') this.renderBatchTable();
      if (tabId === 'video-audio' && window.audioEngine) {
        const canvas = document.getElementById('va-waveform-canvas');
        window.audioEngine.drawWaveform(canvas);
      }
    },

    // 2. Platform Switcher Dropdown

    // 3. Dashboard
    initDashboard() {
      this.updateDashboardStats();
    },

    updateDashboardStats() {
      const stats = window.conversionEngine.stats;
      document.getElementById('stat-conversions-today').textContent = stats.totalConverted;
      document.getElementById('stat-bytes-saved').textContent = window.compressorEngine.formatBytes(stats.bytesSaved);
    },

    // 4. Convert Workbench
    initConvertWorkbench() {
      const subtabs = document.querySelectorAll('#convert-subtabs .sub-tab-btn');
      subtabs.forEach(btn => {
        btn.addEventListener('click', () => {
          subtabs.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.switchConvertCategory(btn.getAttribute('data-category'));
        });
      });

      this.setupDropzone('convert-dropzone', 'convert-file-input', (files) => {
        if (files.length === 1) {
          this.selectConvertFile(files[0]);
        } else if (files.length > 1) {
          // Multiple files -> directly add to batch
          Array.from(files).forEach(f => window.conversionEngine.addToQueue(f, { targetFormat: this.getDefaultFormatForFile(f) }));
          this.showToast(`Added ${files.length} files to Batch Queue`, 'success');
          this.switchTab('batch');
        }
      });

      document.getElementById('btn-remove-selected-file').addEventListener('click', () => {
        this.selectedFile = null;
        document.getElementById('convert-config-card').style.display = 'none';
        document.getElementById('convert-dropzone').style.display = 'block';
      });

      document.getElementById('btn-add-to-batch-queue').addEventListener('click', () => {
        if (!this.selectedFile) return;
        const targetFormat = document.getElementById('convert-target-format').value;
        const quality = document.getElementById('convert-preset-quality').value;
        const codec = document.getElementById('convert-video-codec').value;
        const resolution = document.getElementById('convert-resolution').value;

        window.conversionEngine.addToQueue(this.selectedFile, { targetFormat, quality, codec, resolution });
        this.showToast(`Added ${this.selectedFile.name} to Batch Queue`, 'success');
        this.switchTab('batch');
      });

      const cancelBtn = document.getElementById('btn-cancel-active-convert');
      const resultCard = document.getElementById('convert-result-card');
      const resultName = document.getElementById('convert-result-name');
      const dlResultBtn = document.getElementById('btn-download-converted-result');
      const convertAnotherBtn = document.getElementById('btn-convert-another');
      const previewBox = document.getElementById('convert-result-preview-box');
      const audioPlayer = document.getElementById('convert-result-audio-player');
      const videoPlayer = document.getElementById('convert-result-video-player');
      const imgPreview = document.getElementById('convert-result-img-preview');
      const progPhase = document.getElementById('prog-phase');

      let currentActiveTask = null;

      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
          if (currentActiveTask) {
            window.conversionEngine.cancelTask(currentActiveTask.id);
            this.showToast('Conversion cancelled by user', 'warn');
            progPanel.style.display = 'none';
            document.getElementById('convert-dropzone').style.display = 'block';
          }
        });
      }

      if (convertAnotherBtn) {
        convertAnotherBtn.addEventListener('click', () => {
          this.selectedFile = null;
          resultCard.style.display = 'none';
          previewBox.style.display = 'none';
          audioPlayer.pause(); audioPlayer.src = '';
          videoPlayer.pause(); videoPlayer.src = '';
          document.getElementById('convert-dropzone').style.display = 'block';
        });
      }

      document.getElementById('btn-start-single-convert').addEventListener('click', async () => {
        if (!this.selectedFile) return;
        const targetFormat = document.getElementById('convert-target-format').value;
        const quality = document.getElementById('convert-preset-quality').value;
        const codec = document.getElementById('convert-video-codec').value;
        const resolution = document.getElementById('convert-resolution').value;

        const suggested = window.conversionEngine.generateOutputName(this.selectedFile.name, targetFormat);
        const dest = await window.platformBridge.chooseSavePath(suggested);
        if (!dest) {
          this.showToast('Save cancelled', 'info');
          return;
        }

        const configCard = document.getElementById('convert-config-card');
        const progPanel = document.getElementById('convert-progress-panel');
        const progBar = document.getElementById('prog-bar-fill');
        const progLabel = document.getElementById('prog-percentage-label');
        const taskTitle = document.getElementById('prog-task-title');

        configCard.style.display = 'none';
        resultCard.style.display = 'none';
        progPanel.style.display = 'block';
        progBar.style.width = '0%';
        progLabel.textContent = '0%';
        if (progPhase) progPhase.textContent = 'Initializing Engine...';
        taskTitle.textContent = `Converting ${this.selectedFile.name} → .${targetFormat.toUpperCase()}`;

        const task = window.conversionEngine.addToQueue(this.selectedFile, {
          targetFormat,
          quality,
          codec,
          resolution,
          autoStart: false
        });

        currentActiveTask = task;

        const progressUnsub = (t) => {
          if (t.id === task.id) {
            const pct = Math.min(100, Math.max(0, Math.round(t.progress || 0)));
            progBar.style.width = `${pct}%`;
            progLabel.textContent = `${pct}%`;
            if (t.stage && progPhase) progPhase.textContent = t.stage;
          }
        };

        window.conversionEngine.on('taskProgress', progressUnsub);

        try {
          await window.conversionEngine.runTask(task);
          
          if (task.status === 'completed' && task.outputBlob) {
            const savedAs = await window.platformBridge.writeToDestination(dest, task.outputBlob, task.outputName);
            progPanel.style.display = 'none';
            resultCard.style.display = 'block';
            resultName.textContent = `${task.outputName} (${window.compressorEngine.formatBytes(task.outputBlob.size)})`;

            // Clean up any previously held media preview URLs to prevent renderer memory leaks
            this.cleanupMediaPreview(audioPlayer);
            this.cleanupMediaPreview(videoPlayer);
            this.cleanupMediaPreview(imgPreview);

            const isAudio = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus'].includes(targetFormat.toLowerCase());
            const isVideo = ['mp4', 'webm', 'mov'].includes(targetFormat.toLowerCase());
            const isImg = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(targetFormat.toLowerCase());

            previewBox.style.display = 'block';
            audioPlayer.style.display = isAudio ? 'block' : 'none';
            videoPlayer.style.display = isVideo ? 'block' : 'none';
            imgPreview.style.display = isImg ? 'block' : 'none';

            if (isAudio) this.setMediaPreviewSrc(audioPlayer, task.outputBlob);
            if (isVideo) this.setMediaPreviewSrc(videoPlayer, task.outputBlob);
            if (isImg) this.setMediaPreviewSrc(imgPreview, task.outputBlob);

            dlResultBtn.onclick = async () => {
              await window.platformBridge.saveFileAs(task.outputBlob, task.outputName);
              this.showToast(`Saved ${task.outputName}`, 'success');
              setTimeout(() => {
                this.cleanupMediaPreview(audioPlayer);
                this.cleanupMediaPreview(videoPlayer);
                this.cleanupMediaPreview(imgPreview);
                task.outputBlob = null;
              }, 2000);
            };

            this.showToast(`Converted and saved: ${savedAs}`, 'success');
          } else {
            throw new Error(task.error || 'Conversion failed');
          }
        } catch (e) {
          console.error(e);
          progPanel.style.display = 'none';
          document.getElementById('convert-dropzone').style.display = 'block';
          this.showToast(`Conversion failed: ${e.message}`, 'error');
        } finally {
          currentActiveTask = null;
          this.updateDashboardStats();
        }
      });

      this.switchConvertCategory('video');
    },

    switchConvertCategory(category) {
      this.currentCategory = category;
      const targetSelect = document.getElementById('convert-target-format');
      targetSelect.innerHTML = '';

      const formatMap = {
        video: ['MP4 (MPEG-4 / AAC)', 'WebM (VP8 / Vorbis)', 'MKV (Matroska Container)', 'MOV (Apple QuickTime)', 'AVI (Audio Video Interleave)', 'GIF (Animated GIF)'],
        audio: ['MP3 (MPEG-3 Audio)', 'FLAC (Free Lossless Audio)', 'WAV (PCM Uncompressed)', 'AAC (Advanced Audio Codec)', 'OGG (Vorbis)', 'OPUS (Speech & Music)'],
        image: ['WebP (Small, high quality)', 'PNG (Lossless with Alpha)', 'JPG (Standard Photographic)', 'ICO (Windows Icon)', 'BMP (Bitmap)'],
        file: ['ZIP (Compressed Archive)']
      };

      const formats = formatMap[category] || formatMap.video;
      formats.forEach(f => {
        const val = f.split(' ')[0].toLowerCase();
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = f;
        targetSelect.appendChild(opt);
      });

      document.getElementById('group-video-codec').style.display = (category === 'video') ? 'flex' : 'none';
      document.getElementById('group-resolution').style.display = (category === 'video' || category === 'image') ? 'flex' : 'none';
    },

    selectConvertFile(file) {
      this.selectedFile = file;
      document.getElementById('convert-dropzone').style.display = 'none';
      const configCard = document.getElementById('convert-config-card');
      configCard.style.display = 'block';

      document.getElementById('cfg-file-name').textContent = file.name;
      document.getElementById('cfg-file-size').textContent = window.compressorEngine.formatBytes(file.size);
      
      const fileType = window.conversionEngine.detectFileType(file);
      this.switchConvertCategory(fileType === 'file' ? 'file' : fileType);
      
      // Update subtab active button
      document.querySelectorAll('#convert-subtabs .sub-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-category') === (fileType === 'file' ? 'file' : fileType));
      });
    },

    getDefaultFormatForFile(file) {
      const type = window.conversionEngine.detectFileType(file);
      if (type === 'video') return 'mp4';
      if (type === 'audio') return 'mp3';
      if (type === 'image') return 'webp';
      return 'zip';
    },

    // 5. Video -> Audio Workbench
    initVideoAudioWorkbench() {
      const dropzone = document.getElementById('va-dropzone');
      const controlsCard = document.getElementById('va-controls-card');
      const canvas = document.getElementById('va-waveform-canvas');
      const playerBox = document.getElementById('va-audio-player-box');
      const player = document.getElementById('va-audio-player');
      const durationBadge = document.getElementById('va-audio-duration-badge');
      const extractBtn = document.getElementById('btn-start-extract-audio');
      const resetBtn = document.getElementById('btn-cancel-va');
      const progPanel = document.getElementById('va-progress-panel');
      const progBar = document.getElementById('va-prog-bar-fill');
      const progLabel = document.getElementById('va-prog-percentage-label');
      const progStage = document.getElementById('va-prog-stage');
      const progBitrate = document.getElementById('va-prog-bitrate');

      this.setupDropzone('va-dropzone', 'va-file-input', async (files) => {
        if (files.length > 0) {
          this.selectedVaFile = files[0];
          dropzone.style.display = 'none';
          controlsCard.style.display = 'block';
          playerBox.style.display = 'none';
          progPanel.style.display = 'none';
          resetBtn.style.display = 'none';
          extractBtn.style.display = 'inline-flex';

          window.audioEngine.drawWaveform(canvas);
          this.showToast(`Ready to extract audio from ${files[0].name}`, 'info');
          if (window.ffmpegBridge && window.ffmpegBridge.ensureLoaded) {
            window.ffmpegBridge.ensureLoaded().catch((e) => {
              console.warn('FFmpeg preload failed:', e);
            });
          }
        }
      });

      extractBtn.addEventListener('click', async () => {
        if (!this.selectedVaFile) return;
        const fmt = document.getElementById('va-target-format').value;
        const bitrate = document.getElementById('va-bitrate').value;
        const channels = document.getElementById('va-channels') ? document.getElementById('va-channels').value : 'stereo';
        const outExt = (fmt || 'mp3').toLowerCase();
        const outName = this.selectedVaFile.name.replace(/\.[^/.]+$/, '') + `_soundtrack.${outExt}`;

        extractBtn.disabled = true;
        const dest = await window.platformBridge.chooseSavePath(outName);
        if (!dest) {
          extractBtn.disabled = false;
          this.showToast('Save cancelled', 'info');
          return;
        }

        progPanel.style.display = 'block';
        progBar.style.width = '0%';
        progLabel.textContent = '0%';
        progStage.textContent = 'Initializing Audio Engine...';
        progBitrate.textContent = `${bitrate} kbps`;
        this.showToast(`Extracting & encoding audio stream (${this.selectedVaFile.name})...`, 'info');

        const onProgress = (p) => {
          const pct = typeof p === 'object' ? (typeof p.percent === 'number' ? p.percent : p.progress) : p;
          const stage = typeof p === 'object' ? p.stage : 'Processing audio track...';
          const safePct = Math.min(100, Math.max(0, Math.round(Number(pct) || 0)));
          progBar.style.width = `${safePct}%`;
          progLabel.textContent = `${safePct}%`;
          if (stage) progStage.textContent = stage;
        };

        try {
          const blob = await window.videoEngine.extractAudio(this.selectedVaFile, fmt, { bitrate, channels }, onProgress);
          const savedAs = await window.platformBridge.writeToDestination(dest, blob, outName);

          progBar.style.width = '100%';
          progLabel.textContent = '100%';
          progStage.textContent = 'Extraction Complete!';

          try {
            const previewBuffer = await window.audioEngine.decodeExtractedPreview(blob, outName);
            if (previewBuffer) window.audioEngine.drawWaveform(canvas, previewBuffer);
          } catch (previewErr) {
            console.warn('Waveform preview skipped:', previewErr);
          }
          
          await new Promise(r => setTimeout(r, 400));
          progPanel.style.display = 'none';

          const audioUrl = URL.createObjectURL(blob);
          player.src = audioUrl;
          playerBox.style.display = 'block';
          resetBtn.style.display = 'inline-flex';
          extractBtn.style.display = 'none';

          player.onloadedmetadata = () => {
            const m = Math.floor(player.duration / 60);
            const s = Math.floor(player.duration % 60);
            durationBadge.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
          };

          this.showToast(`Saved soundtrack: ${savedAs}`, 'success');
          this.logTelemetry(`[AUDIO ENGINE] Extracted master audio track: ${outName} (${window.compressorEngine.formatBytes(blob.size)})`, 'success');
        } catch (err) {
          console.error(err);
          this.showToast(`Audio extraction failed: ${err.message}`, 'error');
          progPanel.style.display = 'none';
        } finally {
          extractBtn.disabled = false;
          extractBtn.innerHTML = '<i class="fa-solid fa-bolt"></i> Extract Audio Track';
        }
      });

      resetBtn.addEventListener('click', () => {
        this.selectedVaFile = null;
        controlsCard.style.display = 'none';
        progPanel.style.display = 'none';
        dropzone.style.display = 'block';
        player.pause();
        player.src = '';
      });
    },

    // 6. Compressor Workbench
    initCompressorWorkbench() {
      const slider = document.getElementById('comp-ratio-slider');
      const sliderVal = document.getElementById('comp-slider-val');
      const estSizeVal = document.getElementById('comp-est-size');
      const origSizeVal = document.getElementById('comp-orig-size');
      const progPanel = document.getElementById('comp-progress-panel');
      const progBar = document.getElementById('comp-prog-bar-fill');
      const progLabel = document.getElementById('comp-prog-percentage-label');
      const progStage = document.getElementById('comp-prog-stage');
      const compStatus = document.getElementById('compress-status');
      const startBtn = document.getElementById('btn-start-compression');

      const isLikelyZip = (f) => {
        if (!f) return false;
        if (typeof window.isLikelyZipFile === 'function') return window.isLikelyZipFile(f);
        return (f.name || '').toLowerCase().endsWith('.zip');
      };

      slider.addEventListener('input', () => {
        const val = slider.value;
        sliderVal.textContent = `${val}%`;
        if (this.selectedCompFile) {
          if (isLikelyZip(this.selectedCompFile)) {
            estSizeVal.textContent = 'Archive Unpack Mode';
          } else {
            const est = window.compressorEngine.calculateEstimatedSize(this.selectedCompFile.size, parseInt(val, 10));
            estSizeVal.textContent = `${est.formatted} (-${val}%)`;
          }
        }
      });

      this.setupDropzone('comp-dropzone', 'comp-file-input', (files) => {
        if (files.length > 0) {
          const file = files[0];
          const ext = (file.name || '').split('.').pop().toLowerCase();
          const mediaExts = [
            'mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'm4v', '3gp', 'ts', 'ogv',
            'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'aiff',
            'png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'gif', 'tiff', 'svg'
          ];
          const isMedia = mediaExts.includes(ext) ||
            (file.type && (file.type.startsWith('video/') || file.type.startsWith('audio/') || file.type.startsWith('image/')));
          const isZip = isLikelyZip(file);

          this.selectedCompFile = file;
          document.getElementById('comp-dropzone').style.display = 'none';
          document.getElementById('comp-interactive-card').style.display = 'block';

          origSizeVal.textContent = window.compressorEngine.formatBytes(this.selectedCompFile.size);
          const modeBadge = document.getElementById('comp-mode-badge');

          if (isZip) {
            startBtn.innerHTML = '<i class="fa-solid fa-box-open"></i> Extract ZIP Archive';
            if (modeBadge) modeBadge.textContent = 'Archive Extraction Mode';
            estSizeVal.textContent = 'Archive Unpack Mode';
            this.showToast(`Selected ZIP archive "${file.name}" — ready for extraction.`, 'info');
          } else if (isMedia) {
            startBtn.innerHTML = '<i class="fa-solid fa-compress"></i> Start Compression';
            if (modeBadge) modeBadge.textContent = 'Smart Lossy (High Efficiency)';
            const est = window.compressorEngine.calculateEstimatedSize(this.selectedCompFile.size, parseInt(slider.value, 10));
            estSizeVal.textContent = `${est.formatted} (-${slider.value}%)`;
          } else {
            startBtn.innerHTML = '<i class="fa-solid fa-file-zipper"></i> Package into ZIP';
            if (modeBadge) modeBadge.textContent = 'Lossless ZIP Archiver';
            estSizeVal.textContent = window.compressorEngine.formatBytes(this.selectedCompFile.size);
            this.showToast(`Selected "${file.name}" — will be packaged into a compressed ZIP archive.`, 'info');
          }
        }
      });

      startBtn.addEventListener('click', async () => {
        if (!this.selectedCompFile) return;
        const ratio = parseInt(slider.value, 10);
        const ext = (this.selectedCompFile.name.split('.').pop() || '').toLowerCase();
        const mediaExts = [
          'mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'm4v', '3gp', 'ts', 'ogv',
          'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'aiff',
          'png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'gif', 'tiff', 'svg'
        ];
        const isMedia = mediaExts.includes(ext) || (this.selectedCompFile.type && (this.selectedCompFile.type.startsWith('video/') || this.selectedCompFile.type.startsWith('audio/') || this.selectedCompFile.type.startsWith('image/')));
        const isZip = isLikelyZip(this.selectedCompFile);

        let defaultOutName;
        if (isZip) {
          defaultOutName = this.selectedCompFile.name.replace(/\.zip$/i, '') || 'extracted_archive';
        } else if (isMedia) {
          defaultOutName = this.selectedCompFile.name.replace(/\.[^/.]+$/, '') + `_compressed.${ext}`;
        } else {
          defaultOutName = `${this.selectedCompFile.name}.zip`;
        }

        const dest = await window.platformBridge.chooseSavePath(defaultOutName);
        if (!dest) {
          this.showToast(isZip ? 'Extraction cancelled' : 'Compression cancelled', 'info');
          return;
        }

        startBtn.disabled = true;
        const actionLabel = isZip ? 'Extracting' : 'Compressing';
        if (progPanel) {
          progPanel.style.display = 'block';
          if (progBar) progBar.style.width = '0%';
          if (progLabel) progLabel.textContent = '0%';
          if (progStage) progStage.textContent = `${actionLabel} engine initializing...`;
          if (compStatus) compStatus.innerText = 'Initializing... 0%';
        }
        this.showToast(`${actionLabel} ${this.selectedCompFile.name}...`, 'info');

        const onCompProgress = (pct, meta) => {
          const raw = typeof pct === 'object' ? (pct.rawPercent ?? pct.percent ?? 0) : pct;
          const safePct = Math.min(100, Math.max(0, Math.round(Number(raw) || 0)));
          const stageDesc = (meta && meta.stage) ? meta.stage : `${actionLabel}... ${safePct}%`;
          console.log(`[COMPRESS PROGRESS] ${safePct}%: ${stageDesc}`);
          if (progBar) progBar.style.width = `${safePct}%`;
          if (progLabel) progLabel.textContent = `${safePct}%`;
          if (compStatus) compStatus.innerText = stageDesc;
          if (progStage) progStage.textContent = stageDesc;
        };

        try {
          let blob = await window.compressorEngine.compress(this.selectedCompFile, ratio, onCompProgress);
          const origFile = this.selectedCompFile.file || this.selectedCompFile;
          let notSmaller = false;
          if (!isZip && blob && origFile && origFile.size && blob.size >= origFile.size) {
            // Never hand back a "compressed" file that is bigger than the original.
            notSmaller = true;
            blob = origFile;
          }
          const finalOutName = (blob && blob.serverOutputFileName) ? blob.serverOutputFileName.split('__').pop() : defaultOutName;
          const savedAs = await window.platformBridge.writeToDestination(dest, blob, finalOutName);

          if (progBar) progBar.style.width = '100%';
          if (progLabel) progLabel.textContent = '100%';
          if (progStage) progStage.textContent = isZip ? 'Extraction complete!' : 'Compression complete!';
          if (compStatus) compStatus.innerText = `${isZip ? 'Extraction' : 'Compression'} Complete (100%)`;
          await new Promise(r => setTimeout(r, 400));
          if (progPanel) progPanel.style.display = 'none';

          if (notSmaller) this.showToast(`This file is already well compressed; a copy of the original was saved: ${savedAs}`, 'info');
          else this.showToast(`${isZip ? 'Extracted' : 'Compressed'} & saved: ${savedAs}`, 'success');

          document.getElementById('comp-interactive-card').style.display = 'none';
          document.getElementById('comp-dropzone').style.display = 'block';
          startBtn.innerHTML = '<i class="fa-solid fa-compress"></i> Start Compression';
          this.selectedCompFile = null;
        } catch (err) {
          if (progPanel) progPanel.style.display = 'none';
          this.showToast(`${actionLabel} error: ${err.message}`, 'error');
        } finally {
          startBtn.disabled = false;
        }
      });
    },

    // 7. Batch Queue Workbench
    initBatchWorkbench() {
      window.conversionEngine.on('queueUpdated', () => this.renderBatchTable());
      window.conversionEngine.on('taskProgress', () => this.renderBatchTable());

      document.getElementById('btn-clear-completed-batch').addEventListener('click', () => {
        window.conversionEngine.clearCompleted();
        this.showToast('Cleared finished items from queue', 'info');
      });

      document.getElementById('btn-start-all-batch').addEventListener('click', () => {
        window.conversionEngine.processQueue();
        this.showToast('Batch processing started', 'info');
      });

      document.getElementById('btn-apply-bulk-target').addEventListener('click', () => {
        const target = document.getElementById('batch-bulk-target-select').value;
        window.conversionEngine.queue.forEach(t => {
          if (t.status === 'queued') t.targetFormat = target;
        });
        this.renderBatchTable();
        this.showToast(`Applied .${target.toUpperCase()} target to all pending items`, 'info');
      });

      document.getElementById('batch-threads-select').addEventListener('change', (e) => {
        window.conversionEngine.maxConcurrent = parseInt(e.target.value, 10);
        document.getElementById('engine-threads-info').textContent = `Files are processed on this device (${e.target.value} parallel jobs)`;
      });
    },

    renderBatchTable() {
      const tbody = document.getElementById('batch-table-body');
      const queue = window.conversionEngine.queue;

      // Update Header Queue Badge
      const pendingCount = queue.filter(t => t.status === 'queued' || t.status === 'processing').length;
      document.getElementById('queue-count-badge').textContent = pendingCount;

      if (queue.length === 0) {
        tbody.innerHTML = `
          <tr class="empty-row">
            <td colspan="6">
              <div class="empty-state">
                <i class="fa-solid fa-inbox"></i>
                <p>No items in batch queue. Drag & drop files or add from Convert tab.</p>
              </div>
            </td>
          </tr>`;
        return;
      }

      tbody.innerHTML = '';
      queue.forEach(task => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${task.name}</strong></td>
          <td><span class="chip">${task.type.toUpperCase()}</span></td>
          <td>${window.compressorEngine.formatBytes(task.size)}</td>
          <td><span class="badge badge-cyan">.${task.targetFormat.toUpperCase()}</span></td>
          <td>
            ${task.status === 'processing' 
              ? `<div class="progress-bar-container" style="height:6px; margin:0; width:120px;"><div class="progress-bar-fill" style="width:${task.progress}%"></div></div> <small>${task.progress}%</small>`
              : `<span class="chip status-${task.status}">${task.status.toUpperCase()}</span>`}
          </td>
          <td>
            ${task.status === 'processing'
              ? `<button class="btn btn-sm btn-outline-danger btn-cancel-task" data-id="${task.id}"><i class="fa-solid fa-stop"></i></button>`
              : (task.status === 'completed' 
                  ? `<button class="btn btn-sm btn-outline btn-save-task" data-id="${task.id}"><i class="fa-solid fa-download"></i></button>`
                  : `<button class="btn btn-sm btn-outline-danger btn-cancel-task" data-id="${task.id}"><i class="fa-solid fa-trash"></i></button>`)}
          </td>
        `;
        tbody.appendChild(tr);
      });

      tbody.querySelectorAll('.btn-cancel-task').forEach(b => {
        b.addEventListener('click', () => window.conversionEngine.cancelTask(b.getAttribute('data-id')));
      });

      tbody.querySelectorAll('.btn-save-task').forEach(b => {
        b.addEventListener('click', async () => {
          const t = window.conversionEngine.queue.find(x => x.id === b.getAttribute('data-id'));
          if (t && t.outputBlob) {
            await window.platformBridge.saveFileAs(t.outputBlob, t.outputName);
          }
        });
      });
    },

    // 8. Download Center
    initDownloadCenter() {
      const urlInput = document.getElementById('dl-url-input');
      const analyzeBtn = document.getElementById('btn-analyze-url');
      const streamsCard = document.getElementById('dl-streams-card');

      const tbody = document.getElementById('dl-formats-body');
      const dlStatus = document.getElementById('download-status');
      const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const fmtDur = (sec) => {
        sec = Math.round(Number(sec) || 0);
        if (!sec) return 'unknown';
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
        return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(x).padStart(2, '0')}`;
      };
      const fmtSize = (n) => (!n ? '—' : n >= 1048576 ? `~${(n / 1048576).toFixed(1)} MB` : `~${Math.round(n / 1024)} KB`);
      const log = (m) => { try { if (window.lasDebugLog) window.lasDebugLog(m); window.electronAPI && window.electronAPI.log && window.electronAPI.log(m); } catch (_) {} };
      const copyLogBtn = document.getElementById('btn-copy-debug-log');
      if (copyLogBtn) {
        copyLogBtn.addEventListener('click', async () => {
          const text = `LAS CONVERT ${window.LAS_APP_VERSION || ''} | ${navigator.userAgent}\nserver: ${window.getApiBaseUrl ? window.getApiBaseUrl() : ''}\n${window.lasGetDebugLog ? window.lasGetDebugLog() : ''}`;
          let ok = false;
          try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {
            const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
            try { ok = document.execCommand('copy'); } catch (__) { /* ignore */ } ta.remove();
          }
          this.showToast(ok ? 'Debug log copied. Paste it in a message to support.' : 'Could not copy the log.', ok ? 'success' : 'error');
        });
      }
      const setStatus = (html, kind = 'cyan') => {
        if (!dlStatus) return;
        dlStatus.style.display = 'block';
        dlStatus.className = `badge badge-${kind}`;
        dlStatus.innerHTML = html;
      };
      // Rows are only shown after a real analysis (no placeholder values).
      if (tbody) tbody.innerHTML = '';
      if (streamsCard) streamsCard.style.display = 'none';
      let analyzedUrl = null;
      let analyzedDirect = false;
      const modeSel = document.getElementById('yt-cookies-mode');
      const browserSel = document.getElementById('yt-cookies-browser');
      const stateEl = document.getElementById('yt-cookies-state');
      window.refreshCookieSettings = async () => {
        if (!window.electronAPI || !window.electronAPI.getSettings || !modeSel) {
          if (modeSel) modeSel.disabled = true;
          if (browserSel) browserSel.disabled = true;
          return;
        }
        const st = await window.electronAPI.getSettings();
        modeSel.value = st.cookies.mode;
        browserSel.value = st.cookies.browser;
        document.getElementById('yt-cookies-browser-row').style.opacity = st.cookies.mode === 'browser' ? 1 : 0.6;
        stateEl.textContent = st.cookies.mode === 'file'
          ? (st.cookies.hasFile ? 'Using your cookies.txt.' : 'cookies.txt selected but not loaded yet.')
          : st.cookies.mode === 'browser' ? `Using cookies from ${browserSel.selectedOptions[0].text}.`
          : st.cookies.mode === 'none' ? 'Cookies disabled.' : 'Automatic: tries Chrome, Edge, Brave, Firefox, Avast only if YouTube blocks the download.';
      };
      if (modeSel) {
        const save = async () => {
          try {
            await window.electronAPI.setSettings({ cookies: { mode: modeSel.value, browser: browserSel.value } });
            this.showToast('YouTube cookie setting saved.', 'success');
          } catch (e) { this.showToast(e.message, 'error'); }
          window.refreshCookieSettings();
        };
        modeSel.addEventListener('change', save);
        browserSel.addEventListener('change', save);
        const load = document.getElementById('yt-cookies-load');
        if (load) load.addEventListener('click', async () => {
          if (!window.electronAPI || !window.electronAPI.importCookies) return this.showToast('Available in the desktop app.', 'warning');
          try { if (await window.electronAPI.importCookies()) this.showToast('cookies.txt loaded.', 'success'); }
          catch (e) { this.showToast(String(e.message).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''), 'error'); }
          window.refreshCookieSettings();
        });
        window.refreshCookieSettings().catch(() => {});
      }
      const srvInput = document.getElementById('las-server-url');
      if (srvInput) {
        try { srvInput.value = localStorage.getItem('las_api_base') || ''; } catch (_) {}
        if (window.builtinServer && window.builtinServer()) srvInput.placeholder = `Built-in: ${window.builtinServer()}`;
        document.getElementById('las-server-save').addEventListener('click', () => {
          try {
            const v = window.setApiBaseUrl(srvInput.value);
            this.showToast(v ? `Download server set to ${v}` : 'Using the built-in download server.', 'success');
          } catch (e) { this.showToast('That is not a valid server address.', 'error'); }
        });
      }
      let lastAction = null; // retried after the user supplies cookies
      const botHelp = document.getElementById('yt-bot-help');
      const showBotHelp = (on) => { if (botHelp) botHelp.style.display = on ? 'block' : 'none'; };
      const api = window.electronAPI;
      const retryLast = () => { showBotHelp(false); if (lastAction) lastAction(); };
      const bindOnce = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
      bindOnce('yt-bot-use-browser', async () => {
        if (!api || !api.setSettings) return this.showToast('Cookie options are available in the desktop app.', 'warning');
        await api.setSettings({ cookies: { mode: 'browser', browser: document.getElementById('yt-bot-browser').value } });
        if (window.refreshCookieSettings) window.refreshCookieSettings();
        retryLast();
      });
      bindOnce('yt-bot-load-file', async () => {
        if (!api || !api.importCookies) return this.showToast('Cookie options are available in the desktop app.', 'warning');
        try {
          const r = await api.importCookies();
          if (!r) return;
          this.showToast('cookies.txt loaded.', 'success');
          if (window.refreshCookieSettings) window.refreshCookieSettings();
          retryLast();
        } catch (e) { this.showToast(String(e.message).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''), 'error'); }
      });

      const wakeStatus = (st) => {
        if (st === 'waking') setStatus('<i class="fa-solid fa-mug-hot"></i> Waking server… The free download server sleeps when idle; the first request can take about 1 minute.', 'orange');
        else if (st === 'awake' && dlStatus && /Waking server/.test(dlStatus.innerText)) setStatus('Server is awake, working…');
      };
      const renderRows = (rows) => {
        tbody.innerHTML = rows.map((o) => `
          <tr>
            <td><strong>${esc(o.label)}</strong></td>
            <td>${o.kbps ? `${Number(o.kbps).toLocaleString()} kbps` : '—'}</td>
            <td>${esc(fmtSize(o.bytes))}</td>
            <td><button class="btn btn-sm ${o.kind === 'audio' ? 'btn-outline' : 'btn-primary'} dl-stream-btn" data-fmt="${esc(o.tag)}"><i class="fa-solid ${o.kind === 'audio' ? 'fa-music' : 'fa-download'}"></i> Download</button></td>
          </tr>`).join('');
      };

      analyzeBtn.addEventListener('click', async () => {
        lastAction = () => analyzeBtn.click();
        showBotHelp(false);
        let url;
        try {
          url = window.validateMediaUrl ? window.validateMediaUrl(urlInput.value) : new URL(urlInput.value.trim()).href;
        } catch (e) {
          return this.showToast(e.message || 'Please enter a media stream URL', 'warning');
        }
        analyzeBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Analyzing...';
        analyzeBtn.disabled = true;
        if (dlStatus) dlStatus.style.display = 'none';
        log(`analyze ${url}`);
        try {
          if (window.isStreamingPlatform(url)) {
            let info;
            try {
              info = await window.getMediaInfo(url, { onStatus: wakeStatus });
            } catch (e) {
              if (e && e.code === 'no_endpoints' && window.setApiBaseUrl) {
                const server = window.prompt('Enter your LAS CONVERT download server (PC running "npm run serve"), e.g. http://192.168.1.20:3000');
                if (!server) throw e;
                window.setApiBaseUrl(server);
                info = await window.getMediaInfo(url, { onStatus: wakeStatus });
              } else if (e && e.code === 'unsupported') {
                info = null; // not a site yt-dlp knows: treat as a direct file link below
              } else throw e;
            }
            if (!info) {
              const data = await window.downloadEngine.analyzeUrl(url);
              document.getElementById('dl-media-title').textContent = data.title;
              document.getElementById('dl-media-author').textContent = `${data.author} • ${data.duration}`;
              renderRows((data.formats || []).map((f) => ({ label: f.quality, tag: f.tag, kind: f.tag === 'mp3' ? 'audio' : 'video' })));
              analyzedUrl = url; analyzedDirect = true;
              streamsCard.style.display = 'block';
              return;
            }
            document.getElementById('dl-media-title').textContent = info.title;
            document.getElementById('dl-media-author').textContent = `${info.uploader || 'Unknown channel'} • Duration: ${fmtDur(info.duration)}`;
            renderRows(info.options || []);
            log(`analyzed ${url}: ${(info.options || []).length} options${info.note ? ` (${info.note})` : ''}`);
            if (info.note) setStatus(`<i class="fa-solid fa-circle-info"></i> ${esc(info.note)}`, 'orange');
          } else {
            const data = await window.downloadEngine.analyzeUrl(url);
            document.getElementById('dl-media-title').textContent = data.title;
            document.getElementById('dl-media-author').textContent = `${data.author} • ${data.duration}`;
            renderRows((data.formats || []).map((f) => ({ label: f.quality, tag: f.tag, kind: f.tag === 'mp3' ? 'audio' : 'video' })));
          }
          analyzedUrl = url;
          analyzedDirect = !window.isStreamingPlatform(url);
          streamsCard.style.display = 'block';
          this.showToast('Media analyzed.', 'success');
        } catch (e) {
          log(`analyze failed: ${e.message}`);
          streamsCard.style.display = 'none';
          setStatus(`Analyze failed: ${esc(e.message)}`, 'red');
          if (e && e.code === 'bot_check') showBotHelp(true);
          this.showToast(`Analyze failed: ${e.message}`, 'error');
        } finally {
          analyzeBtn.disabled = false;
          analyzeBtn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Analyze Link';
        }
      });

      let activeDownload = null;
      if (dlStatus) {
        dlStatus.addEventListener('click', (ev) => {
          if (ev.target.closest('.dl-cancel') && activeDownload) { activeDownload.abort(); setStatus('Cancelling…'); return; }
          const b = ev.target.closest('.dl-open-folder');
          if (b && window.electronAPI && window.electronAPI.showItemInFolder) {
            window.electronAPI.showItemInFolder(b.getAttribute('data-path')).catch((e) => this.showToast(e.message, 'error'));
          }
        });
      }

      tbody.addEventListener('click', async (ev) => {
        const btn = ev.target.closest('.dl-stream-btn');
        if (!btn || btn.disabled) return;
        const fmt = btn.getAttribute('data-fmt');
        const url = analyzedUrl;
        if (!url) return this.showToast('Analyze a link first.', 'warning');
        const original = btn.innerHTML;
        lastAction = () => btn.click();
        showBotHelp(false);
        const allBtns = tbody.querySelectorAll('.dl-stream-btn');
        allBtns.forEach((b) => { b.disabled = true; });
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Starting...';
        setStatus('Downloading with yt-dlp...');
        log(`download ${fmt} ${url}`);
        try {
          if (!analyzedDirect) {
            const ctrl = new AbortController();
            activeDownload = ctrl;
            let retryNote = '';
            const cancelBtn = ' <button class="btn btn-sm btn-outline dl-cancel"><i class="fa-solid fa-xmark"></i> Cancel</button>';
            const r = await window.savePlatformMedia(url, {
              audio: fmt === 'mp3',
              quality: /^\d+p$/.test(fmt) ? parseInt(fmt, 10) : fmt === 'best' ? 4320 : 720,
              formatId: fmt.startsWith('id:') ? fmt.slice(3) : '',
              signal: ctrl.signal,
              onStatus: (st) => {
                if (st === 'waking' || st === 'awake') return wakeStatus(st);
                retryNote = st;
                setStatus(`<i class="fa-solid fa-rotate"></i> ${esc(st)}${cancelBtn}`, 'orange');
              },
              onProgress: (p, info = {}) => {
                const pct = Math.max(0, Math.min(100, Number(p) || 0));
                btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${pct}%`;
                if (pct >= 95 && info.stage !== 'transfer') { setStatus(`Finishing (merging / converting)...${cancelBtn}`); return; }
                const bits = [`${pct}%`];
                if (info.downloaded && info.total) bits.push(`${(info.downloaded / 1048576).toFixed(1)} / ${(info.total / 1048576).toFixed(1)} MB`);
                if (info.speed) bits.push(info.speed);
                if (info.eta) bits.push(`ETA ${info.eta}`);
                const what = info.stage === 'transfer' ? 'Saving to this device' : info.stage === 'server' ? 'Server downloading' : 'Downloading';
                const note = retryNote && /retrying/i.test(retryNote) && info.speed ? '' : '';
                retryNote = note;
                setStatus(`${what}… ${esc(bits.join(' · '))}${cancelBtn}`);
              },
            }).finally(() => { activeDownload = null; });
            const size = r.bytes ? ` (${(r.bytes / 1048576).toFixed(1)} MB)` : '';
            const canOpen = r.filePath && window.electronAPI && window.electronAPI.showItemInFolder;
            setStatus(`<i class="fa-solid fa-check"></i> Saved to <code>${esc(r.location || r.name)}</code>${esc(size)}`
              + (canOpen ? ` <button class="btn btn-sm btn-outline dl-open-folder" data-path="${esc(r.filePath)}"><i class="fa-solid fa-folder-open"></i> Open folder</button>` : ''), 'emerald');
            btn.innerHTML = '<i class="fa-solid fa-check text-emerald"></i> Saved';
            log(`saved ${r.location || r.name}`);
            this.showToast(`Saved ${r.name}`, 'success');
          } else {
            const defaultName = `download.${fmt === 'mp3' ? 'mp3' : 'mp4'}`;
            const dest = await window.platformBridge.chooseSavePath(defaultName);
            if (!dest) { btn.innerHTML = original; setStatus('Cancelled.'); return; }
            const result = await window.downloadEngine.downloadStream(url, fmt);
            await window.platformBridge.writeToDestination(dest, result.blob, result.name || defaultName);
            setStatus(`<i class="fa-solid fa-check"></i> Saved ${esc(result.name || defaultName)}`, 'emerald');
            btn.innerHTML = '<i class="fa-solid fa-check text-emerald"></i> Saved';
          }
        } catch (err) {
          if (err && err.code === 'cancelled') { btn.innerHTML = original; setStatus('Download cancelled.'); return; }
          console.error('Download failed:', err);
          log(`download failed (${fmt}) ${url}: ${err.message}`);
          btn.innerHTML = '<i class="fa-solid fa-arrow-rotate-right"></i> Retry';
          setStatus(`Download failed: ${esc(err.message)}`, 'red');
          if (err && err.code === 'bot_check') showBotHelp(true);
          this.showToast(`Download failed: ${err.message}`, 'error');
        } finally {
          allBtns.forEach((b) => { b.disabled = false; });
        }
      });

      // Native Platform Downloads

    },

    // 9. Media Inspector
    initInspectorWorkbench() {
      this.setupDropzone('inspect-dropzone', 'inspect-file-input', async (files) => {
        if (files.length > 0) {
          const file = files[0];
          this.showToast(`Analyzing container of ${file.name}...`, 'info');
          const info = await window.mediaInspector.inspect(file);

          document.getElementById('ins-format').textContent = info.container;
          document.getElementById('ins-size').textContent = info.size;
          document.getElementById('ins-duration').textContent = info.duration;
          document.getElementById('ins-bitrate').textContent = info.overallBitrate;
          
          document.getElementById('ins-v-codec').textContent = info.video.codec;
          document.getElementById('ins-v-res').textContent = info.video.resolution;
          document.getElementById('ins-v-fps').textContent = info.video.fps;
          document.getElementById('ins-v-colorspace').textContent = info.video.colorspace;

          document.getElementById('ins-a-codec').textContent = info.audio.codec;
          document.getElementById('ins-a-channels').textContent = info.audio.channels;
          document.getElementById('ins-a-samplerate').textContent = info.audio.sampleRate;
          document.getElementById('ins-a-bitdepth').textContent = info.audio.bitDepth;

          document.getElementById('ins-raw-meta').textContent = info.rawTree;
          document.getElementById('inspector-results-card').style.display = 'block';
        }
      });
    },

    // 10. Quick Editor
    initQuickEditor() {
      let editorFile = null;

      this.setupDropzone('editor-dropzone', 'editor-file-input', (files) => {
        if (files.length > 0) {
          editorFile = files[0];
          const videoEl = document.getElementById('editor-video-preview');
          videoEl.src = URL.createObjectURL(editorFile);
          document.getElementById('editor-dropzone').style.display = 'none';
          document.getElementById('editor-stage-card').style.display = 'block';
        }
      });

      document.getElementById('btn-export-edited-media').addEventListener('click', async () => {
        if (!editorFile) return;
        const start = document.getElementById('edit-trim-start').value;
        const end = document.getElementById('edit-trim-end').value;
        const speed = parseFloat(document.getElementById('edit-speed').value) || 1;
        const outName = editorFile.name.replace(/\.[^/.]+$/, '') + `_edited.mp4`;

        const dest = await window.platformBridge.chooseSavePath(outName);
        if (!dest) {
          this.showToast('Edit export cancelled', 'info');
          return;
        }

        this.showToast(`Rendering edit (Cut: ${start} - ${end} @ ${speed}x)...`, 'info');
        try {
          const blob = await window.ffmpegBridge.trim(editorFile, { start, end, speed });
          const savedAs = await window.platformBridge.writeToDestination(dest, blob, outName);
          this.showToast(`Render complete and saved: ${savedAs}`, 'success');
        } catch (err) {
          this.showToast(`Edit failed: ${err.message}`, 'error');
        }
      });
    },

    // 11. Subtitles Studio
    initSubtitlesWorkbench() {
      this.setupDropzone('sub-dropzone', 'sub-file-input', async (files) => {
        if (files.length > 0) {
          const file = files[0];
          const isVideo = file.type?.startsWith('video/') || /\.(mp4|mkv|mov|webm|avi|flv|m4v)$/i.test(file.name);
          if (isVideo) {
            const editor = document.getElementById('sub-editor-content');
            editor.value = `[AI SUBTITLE STUDIO]\nAnalyzing video: ${file.name}\n1. Extracting 16kHz audio track...\n2. Downloading/Loading Whisper AI model (this may take a couple minutes on first run)...\nPlease wait, your subtitles will appear here automatically when ready!`;
            this.showToast(`Loading Whisper AI model for ${file.name}... (First run downloads weights into cache)`, 'info');
            try {
              if (window.subtitleEngine && window.subtitleEngine.generateSRTFromVideo) {
                const srt = await window.subtitleEngine.generateSRTFromVideo(file, {
                  onProgress: (pct, stage) => {
                    this.showToast(`${stage} (${pct}%)`, 'info');
                    editor.value = `[AI SUBTITLE STUDIO]\nProcessing: ${file.name}\nProgress: ${pct}%\nStage: ${stage}\n\nDownloading/decoding speech stream...`;
                  }
                });
                editor.value = srt;
                this.showToast('Subtitles generated successfully from video!', 'success');
              }
            } catch (err) {
              editor.value = `Error generating subtitles: ${err.message}\n\nPlease verify model network connection or use an audio-only file.`;
              this.showToast(`Subtitle generation note: ${err.message}`, 'warning');
            }
          } else {
            const text = await file.text();
            document.getElementById('sub-editor-content').value = text;
            this.showToast('Subtitle loaded into editor', 'success');
          }
        }
      });

      document.getElementById('btn-convert-subtitles').addEventListener('click', async () => {
        const text = document.getElementById('sub-editor-content').value;
        const fmt = document.getElementById('sub-target-fmt').value;
        const offset = parseInt(document.getElementById('sub-offset-ms').value || '0', 10);
        const outName = `subtitles_converted.${fmt}`;

        if (!text) {
          return this.showToast('Editor is empty. Drop a subtitle file or video first.', 'warning');
        }

        let processed = text;
        if (offset !== 0 && window.subtitleEngine?.shiftTimecode) {
          processed = window.subtitleEngine.shiftTimecode(processed, offset);
        }

        let output = processed;
        if (fmt === 'vtt' && window.subtitleEngine?.convertToVTT) output = window.subtitleEngine.convertToVTT(processed);
        if (fmt === 'ass' && window.subtitleEngine?.convertToASS) output = window.subtitleEngine.convertToASS(processed);

        if (fmt === 'srt' && window.downloadSRTFile) {
          window.downloadSRTFile(output, outName);
          this.showToast('Downloaded .SRT subtitles', 'success');
          return;
        }

        const dest = await window.platformBridge.chooseSavePath(outName);
        if (!dest) return;

        const blob = new Blob([output], { type: 'text/plain;charset=utf-8' });
        await window.platformBridge.writeToDestination(dest, blob, outName);
        this.showToast(`Saved subtitles as .${fmt.toUpperCase()}`, 'success');
      });
    },

    // 12. Audio to Text (Word-for-Word) Workbench
    initSpeechWorkbench() {
      this.selectedSpeechFile = null;
      this.currentSpeechResult = null;
      let isLiveDictating = false;
      let wordChipElements = [];

      const dropzone = document.getElementById('speech-dropzone');
      const selectedBox = document.getElementById('speech-selected-card');
      const fileName = document.getElementById('speech-file-name');
      const fileSize = document.getElementById('speech-file-size');
      const removeBtn = document.getElementById('btn-remove-speech-file');
      const transcribeBtn = document.getElementById('btn-start-speech-transcribe');
      const retranslateBtn = document.getElementById('btn-retranslate-speech');
      const srcLangSelect = document.getElementById('speech-lang-select');
      const targetLangSelect = document.getElementById('speech-target-lang-select');
      const srcLangTag = document.getElementById('speech-src-lang-tag');
      const targetLangTag = document.getElementById('speech-target-lang-tag');
      const wordCountBadge = document.getElementById('speech-word-count');
      const statusBadge = document.getElementById('speech-status-indicator');
      const interactiveBox = document.getElementById('speech-interactive-words');
      const editorSpokenText = document.getElementById('speech-full-text-editor');
      const editorTransText = document.getElementById('speech-translated-text-editor');
      const playerCard = document.getElementById('speech-player-card');
      const audioPlayer = document.getElementById('speech-audio-player');
      const dictationBtn = document.getElementById('btn-toggle-live-dictation');
      const dictationText = document.getElementById('dictation-btn-text');

      const updateLangTags = () => {
        if (srcLangTag && srcLangSelect) srcLangTag.textContent = srcLangSelect.value;
        if (targetLangTag && targetLangSelect) targetLangTag.textContent = targetLangSelect.value;
      };

      if (srcLangSelect) srcLangSelect.addEventListener('change', updateLangTags);
      if (targetLangSelect) {
        targetLangSelect.addEventListener('change', () => {
          updateLangTags();
          if (this.currentSpeechResult && retranslateBtn) {
            retranslateBtn.style.display = 'block';
          }
        });
      }
      updateLangTags();

      this.setupDropzone('speech-dropzone', 'speech-file-input', (files) => {
        if (files.length > 0) {
          this.selectedSpeechFile = files[0];
          dropzone.style.display = 'none';
          selectedBox.style.display = 'block';
          fileName.textContent = this.selectedSpeechFile.name;
          fileSize.textContent = window.compressorEngine.formatBytes(this.selectedSpeechFile.size);
          this.showToast(`Selected ${this.selectedSpeechFile.name} for speech transcription`, 'info');
        }
      });

      if (removeBtn) {
        removeBtn.addEventListener('click', () => {
          this.selectedSpeechFile = null;
          this.currentSpeechResult = null;
          selectedBox.style.display = 'none';
          dropzone.style.display = 'block';
          playerCard.style.display = 'none';
          if (retranslateBtn) retranslateBtn.style.display = 'none';
          renderWords([]);
          editorSpokenText.value = '';
          editorTransText.value = '';
        });
      }

      // Render word chips with word-for-word translation, timecodes, and click-to-seek
      const renderWords = (timedWords = []) => {
        wordChipElements = [];
        wordCountBadge.textContent = `${timedWords.length} words`;

        if (timedWords.length === 0) {
          interactiveBox.innerHTML = `
            <div class="empty-state">
              <i class="fa-solid fa-wave-square fa-2x text-muted"></i>
              <p>Drop an audio file or click "Live Microphone Dictation" to see word-for-word transcript and translation stream in real time.</p>
            </div>`;
          return;
        }

        interactiveBox.innerHTML = '';
        timedWords.forEach((timed, idx) => {
          const chip = document.createElement('div');
          chip.className = 'speech-word-chip';
          chip.dataset.index = idx;
          chip.dataset.startSec = timed.startSec;
          chip.dataset.endSec = timed.endSec;

          const metaDiv = document.createElement('div');
          metaDiv.className = 'chip-meta';
          metaDiv.innerHTML = `<span>#${timed.index || idx + 1}</span><span>${timed.startTime ? timed.startTime.split(',')[0] : ''}</span>`;

          const spokenDiv = document.createElement('div');
          spokenDiv.className = 'chip-spoken';
          spokenDiv.textContent = timed.word;

          const transDiv = document.createElement('div');
          transDiv.className = 'chip-trans';
          transDiv.textContent = timed.translation || '';

          chip.appendChild(metaDiv);
          chip.appendChild(spokenDiv);
          chip.appendChild(transDiv);

          chip.title = `[${timed.startTime || '00:00:00'} → ${timed.endTime || '00:00:01'}] Click to seek audio & pronounce`;
          chip.addEventListener('click', () => {
            if (audioPlayer && audioPlayer.src) {
              audioPlayer.currentTime = timed.startSec;
              audioPlayer.play();
            }
            const targetLang = targetLangSelect ? targetLangSelect.value : 'es-ES';
            window.speechEngine.speakText(timed.translation || timed.word, targetLang, 1.0);
          });

          wordChipElements.push({ element: chip, startSec: timed.startSec, endSec: timed.endSec });
          interactiveBox.appendChild(chip);
        });
      };

      // Real-time Karaoke word synchronization as audio plays
      if (audioPlayer) {
        let lastActiveIndex = -1;
        audioPlayer.addEventListener('timeupdate', () => {
          if (!wordChipElements || wordChipElements.length === 0) return;
          const ct = audioPlayer.currentTime;
          let foundIndex = -1;

          for (let i = 0; i < wordChipElements.length; i++) {
            const item = wordChipElements[i];
            if (ct >= item.startSec && ct <= (item.endSec + 0.1)) {
              foundIndex = i;
              break;
            }
          }

          if (foundIndex !== lastActiveIndex) {
            if (lastActiveIndex >= 0 && wordChipElements[lastActiveIndex]) {
              wordChipElements[lastActiveIndex].element.classList.remove('active');
            }
            if (foundIndex >= 0 && wordChipElements[foundIndex]) {
              const activeEl = wordChipElements[foundIndex].element;
              activeEl.classList.add('active');
              activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            }
            lastActiveIndex = foundIndex;
          }
        });
      }

      // Audio Speed chips (0.75x, 1.0x, 1.25x, 1.5x, 2.0x)
      document.querySelectorAll('.btn-speed-chip').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.btn-speed-chip').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const speed = parseFloat(btn.dataset.speed || '1.0');
          if (audioPlayer) audioPlayer.playbackRate = speed;
          this.showToast(`Audio speed: ${speed}x`, 'info');
        });
      });

      // Transcribe & Translate Button
      if (transcribeBtn) {
        transcribeBtn.addEventListener('click', async () => {
          const srcLang = srcLangSelect ? srcLangSelect.value : 'en-US';
          const targetLang = targetLangSelect ? targetLangSelect.value : 'es-ES';
          const modelSelect = document.getElementById('speech-model-select');
          const model = modelSelect ? modelSelect.value : 'Xenova/whisper-base';

          transcribeBtn.disabled = true;
          statusBadge.className = 'chip status-processing';
          statusBadge.textContent = 'Transcribing & Translating...';
          this.showToast(`Analyzing speech & filtering noise (${model.split('/')[1] || 'whisper-base'})...`, 'info');

          try {
            const result = await window.speechEngine.transcribeMediaFile(this.selectedSpeechFile, {
              srcLang,
              targetLang,
              model,
              onProgress: (p) => {
                const stage = typeof p === 'object' ? p.stage : '';
                if (stage) statusBadge.textContent = stage;
              },
              onWordStream: (pairs, full, transFull) => {
                renderWords(pairs.map(p => ({
                  word: p.word,
                  translation: p.translation,
                  index: p.index,
                  startSec: p.index * 0.35,
                  endSec: (p.index * 0.35) + 0.3,
                  startTime: window.speechEngine.formatTimecode(p.index * 0.35),
                  endTime: window.speechEngine.formatTimecode((p.index * 0.35) + 0.3)
                })));
                editorSpokenText.value = full;
                editorTransText.value = transFull;
              }
            });

            this.currentSpeechResult = result;
            console.log("Word Chunks:", result.words);
            renderWords(result.words);
            editorSpokenText.value = result.text;
            editorTransText.value = result.translatedText;

            if (result.audioBlob) {
              audioPlayer.src = URL.createObjectURL(result.audioBlob);
              playerCard.style.display = 'block';
            }

            if (retranslateBtn) retranslateBtn.style.display = 'block';
            statusBadge.className = 'chip status-completed';
            statusBadge.textContent = 'Complete';
            this.showToast(`Transcribed & translated ${result.wordCount} words successfully!`, 'success');
          } catch (err) {
            console.error(err);
            statusBadge.className = 'chip status-error';
            statusBadge.textContent = 'Error';
            this.showToast(`Speech error: ${err.message}`, 'error');
          } finally {
            transcribeBtn.disabled = false;
          }
        });
      }

      // Re-Translate Existing Transcript Button
      if (retranslateBtn) {
        retranslateBtn.addEventListener('click', () => {
          if (!this.currentSpeechResult || !this.currentSpeechResult.words) return;
          const srcLang = srcLangSelect ? srcLangSelect.value : 'en-US';
          const targetLang = targetLangSelect ? targetLangSelect.value : 'es-ES';

          this.showToast(`Re-translating word-for-word into ${targetLang}...`, 'info');
          const updatedWords = this.currentSpeechResult.words.map(tw => ({
            ...tw,
            translation: window.speechEngine.translateWord(tw.word, srcLang, targetLang)
          }));

          this.currentSpeechResult.words = updatedWords;
          this.currentSpeechResult.targetLang = targetLang;
          this.currentSpeechResult.translatedText = updatedWords.map(w => w.translation).join(' ');
          this.currentSpeechResult.bilingualSrt = window.speechEngine.generateBilingualSRT(updatedWords);
          this.currentSpeechResult.bilingualVtt = window.speechEngine.generateBilingualVTT(updatedWords);

          renderWords(updatedWords);
          editorTransText.value = this.currentSpeechResult.translatedText;
          updateLangTags();
          this.showToast('Updated word-for-word translation!', 'success');
        });
      }

      // Live Microphone Dictation Toggle
      if (dictationBtn) {
        dictationBtn.addEventListener('click', () => {
          if (!isLiveDictating) {
            try {
              const srcLang = srcLangSelect ? srcLangSelect.value : 'en-US';
              const targetLang = targetLangSelect ? targetLangSelect.value : 'es-ES';
              const modelSelect = document.getElementById('speech-model-select');
              const model = modelSelect ? modelSelect.value : 'Xenova/whisper-base.en';

              window.speechEngine.startLiveDictation({
                srcLang,
                targetLang,
                model,
                onWord: (pairs, full, transFull) => {
                  const timed = pairs.map(p => ({
                    word: p.word,
                    translation: p.translation,
                    index: p.index,
                    startSec: p.index * 0.4,
                    endSec: (p.index * 0.4) + 0.35,
                    startTime: window.speechEngine.formatTimecode(p.index * 0.4),
                    endTime: window.speechEngine.formatTimecode((p.index * 0.4) + 0.35)
                  }));

                  this.currentSpeechResult = {
                    words: timed,
                    text: full,
                    translatedText: transFull,
                    wordCount: pairs.length
                  };

                  renderWords(timed);
                  editorSpokenText.value = full;
                  editorTransText.value = transFull;
                  if (retranslateBtn) retranslateBtn.style.display = 'block';
                },
                onStatusChange: (status) => {
                  if (statusBadge) statusBadge.textContent = status;
                },
                onError: (err) => {
                  this.showToast(`Dictation error: ${err && err.message ? err.message : err}`, 'warn');
                }
              });
              isLiveDictating = true;
              dictationBtn.classList.remove('btn-secondary');
              dictationBtn.classList.add('btn-danger');
              dictationText.textContent = 'Stop Dictation (Listening...)';
              statusBadge.className = 'chip status-processing';
              statusBadge.textContent = 'Live Listening & Translating...';
              this.showToast('Microphone active — speaking and translating word-for-word!', 'info');
            } catch (err) {
              this.showToast(err.message, 'error');
            }
          } else {
            window.speechEngine.stopLiveDictation();
            isLiveDictating = false;
            dictationBtn.classList.remove('btn-danger');
            dictationBtn.classList.add('btn-secondary');
            dictationText.textContent = 'Live Microphone Dictation';
            statusBadge.className = 'chip status-ready';
            statusBadge.textContent = 'Ready';
            this.showToast('Dictation session saved to editors.', 'success');
          }
        });
      }

      // Export Buttons
      // 1. Copy Spoken
      document.getElementById('btn-copy-transcript').addEventListener('click', () => {
        const text = editorSpokenText.value;
        if (!text) return this.showToast('Spoken transcript is empty', 'warning');
        navigator.clipboard.writeText(text);
        this.showToast('Copied spoken transcript to clipboard!', 'success');
      });

      // 2. Copy Translated
      document.getElementById('btn-copy-translated').addEventListener('click', () => {
        const text = editorTransText.value;
        if (!text) return this.showToast('Translated text is empty', 'warning');
        navigator.clipboard.writeText(text);
        this.showToast('Copied translated text to clipboard!', 'success');
      });

      // 3. TTS Spoken
      document.getElementById('btn-tts-spoken').addEventListener('click', () => {
        const text = editorSpokenText.value;
        if (!text) return this.showToast('No spoken text to read', 'warning');
        const lang = srcLangSelect ? srcLangSelect.value : 'en-US';
        window.speechEngine.speakText(text, lang, 1.0);
        this.showToast(`Speaking transcript in ${lang}...`, 'info');
      });

      // 4. TTS Translated
      document.getElementById('btn-tts-translated').addEventListener('click', () => {
        const text = editorTransText.value;
        if (!text) return this.showToast('No translated text to read', 'warning');
        const lang = targetLangSelect ? targetLangSelect.value : 'es-ES';
        window.speechEngine.speakText(text, lang, 1.0);
        this.showToast(`Speaking translation in ${lang}...`, 'info');
      });

      // 5. Download TXT (Spoken)
      document.getElementById('btn-download-transcript-txt').addEventListener('click', async () => {
        const text = editorSpokenText.value;
        if (!text) return this.showToast('Spoken transcript is empty', 'warning');
        const dest = await window.platformBridge.chooseSavePath('transcript_spoken.txt');
        if (!dest) return;
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        await window.platformBridge.writeToDestination(dest, blob, 'transcript_spoken.txt');
        this.showToast('Saved spoken transcript as .TXT', 'success');
      });

      // 6. Download TXT (Translated)
      document.getElementById('btn-download-translated-txt').addEventListener('click', async () => {
        const text = editorTransText.value;
        if (!text) return this.showToast('Translated text is empty', 'warning');
        const dest = await window.platformBridge.chooseSavePath('transcript_translated.txt');
        if (!dest) return;
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        await window.platformBridge.writeToDestination(dest, blob, 'transcript_translated.txt');
        this.showToast('Saved translated transcript as .TXT', 'success');
      });

      // 7. Download Bilingual .SRT
      document.getElementById('btn-download-bilingual-srt').addEventListener('click', async () => {
        const text = editorSpokenText.value;
        if (!text) return this.showToast('Transcript is empty', 'warning');
        const timed = this.currentSpeechResult && this.currentSpeechResult.words.length > 0
          ? this.currentSpeechResult.words
          : window.speechEngine.generateTimedWords(text, 10, srcLangSelect.value, targetLangSelect.value);
        const srt = window.speechEngine.generateBilingualSRT(timed);
        const dest = await window.platformBridge.chooseSavePath('transcript_bilingual.srt');
        if (!dest) return;
        const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
        await window.platformBridge.writeToDestination(dest, blob, 'transcript_bilingual.srt');
        this.showToast('Saved Bilingual .SRT subtitles', 'success');
      });

      // 8. Download Spoken .SRT
      document.getElementById('btn-download-transcript-srt').addEventListener('click', async () => {
        const text = editorSpokenText.value;
        if (!text) return this.showToast('Transcript is empty', 'warning');
        const timed = this.currentSpeechResult && this.currentSpeechResult.words.length > 0
          ? this.currentSpeechResult.words
          : window.speechEngine.generateTimedWords(text, 10, srcLangSelect.value, targetLangSelect.value);
        const srt = window.speechEngine.generateSRT(timed);
        const dest = await window.platformBridge.chooseSavePath('transcript_spoken.srt');
        if (!dest) return;
        const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
        await window.platformBridge.writeToDestination(dest, blob, 'transcript_spoken.srt');
        this.showToast('Saved Spoken .SRT subtitles', 'success');
      });

      // 9. Download Bilingual .VTT
      document.getElementById('btn-download-bilingual-vtt').addEventListener('click', async () => {
        const text = editorSpokenText.value;
        if (!text) return this.showToast('Transcript is empty', 'warning');
        const timed = this.currentSpeechResult && this.currentSpeechResult.words.length > 0
          ? this.currentSpeechResult.words
          : window.speechEngine.generateTimedWords(text, 10, srcLangSelect.value, targetLangSelect.value);
        const vtt = window.speechEngine.generateBilingualVTT(timed);
        const dest = await window.platformBridge.chooseSavePath('transcript_bilingual.vtt');
        if (!dest) return;
        const blob = new Blob([vtt], { type: 'text/plain;charset=utf-8' });
        await window.platformBridge.writeToDestination(dest, blob, 'transcript_bilingual.vtt');
        this.showToast('Saved Bilingual WebVTT (.VTT) subtitles', 'success');
      });
    },

    // 13. Android Tools

    // 14. iPhone / iOS Tools

    // 15. Telemetry & Log Stream

    logTelemetry(msg, level = 'info') {
      if (level === 'error') console.error(msg); else console.log(msg);
    },

    // 16. History View
    initHistoryView() {
      document.getElementById('btn-export-history-json').addEventListener('click', () => {
        window.historyEngine.exportJSON();
        this.showToast('Exported history audit log as JSON', 'success');
      });

      document.getElementById('btn-clear-all-history').addEventListener('click', () => {
        window.historyEngine.clear();
        this.renderHistoryTable();
        this.showToast('Cleared all conversion history', 'info');
      });

      document.getElementById('history-search-input').addEventListener('input', (e) => {
        this.renderHistoryTable(e.target.value);
      });
    },

    renderHistoryTable(filter = '') {
      const tbody = document.getElementById('history-table-body');
      let records = window.historyEngine.getAll();

      if (filter) {
        records = records.filter(r => r.name.toLowerCase().includes(filter.toLowerCase()) || r.targetFormat.toLowerCase().includes(filter.toLowerCase()));
      }

      if (records.length === 0) {
        tbody.innerHTML = `
          <tr class="empty-row">
            <td colspan="8">
              <div class="empty-state">
                <i class="fa-solid fa-clock-rotate-left"></i>
                <p>No conversion history recorded yet.</p>
              </div>
            </td>
          </tr>`;
        return;
      }

      tbody.innerHTML = '';
      records.forEach(r => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><small class="text-muted">${r.timestamp}</small></td>
          <td><strong>${r.name}</strong></td>
          <td><span class="badge badge-cyan">.${r.targetFormat}</span></td>
          <td>${window.compressorEngine.formatBytes(r.inputSize)}</td>
          <td>${window.compressorEngine.formatBytes(r.outputSize)}</td>
          <td><strong class="text-emerald">${r.savings}</strong></td>
          <td><span class="chip status-completed">${r.status}</span></td>
          <td><button class="btn btn-sm btn-outline"><i class="fa-solid fa-arrow-rotate-right"></i></button></td>
        `;
        tbody.appendChild(tr);
      });
    },

    // 17. Error & Diagnostic Center

    // 18. Settings
    initSettings() {
      const v = document.getElementById('about-version');
      const ver = (window.LAS_APP_VERSION && !String(window.LAS_APP_VERSION).startsWith('__')) ? window.LAS_APP_VERSION : '1.8.0';
      if (v) v.textContent = `v${ver}`;
    },


    // 19. Export Release Package Modal


    // 20. Global Drag & Drop Helper
    setupDropzone(dropzoneId, inputId, callback) {
      const dropzone = document.getElementById(dropzoneId);
      const input = document.getElementById(inputId);
      if (!dropzone || !input) return;

      dropzone.addEventListener('click', () => input.click());

      input.addEventListener('change', async (event) => {
        const fileData = await safelyReadFile(event);
        if (fileData) {
          console.log("Ready to process:", fileData.name);
          let allFiles = [fileData.file || fileData];
          if (event.target && event.target.files && event.target.files.length > 1) {
            const all = await safelyReadFiles(event);
            if (all && all.length > 0) allFiles = all.map(f => f.file || f);
          }
          callback(allFiles, fileData);
        }
        // Allow picking the same file again (no 'change' event otherwise).
        try { input.value = ''; } catch (_) {}
      });

      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });

      dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));

      dropzone.addEventListener('drop', async (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          const fileData = await safelyReadFile(e.dataTransfer.files[0]);
          if (fileData) {
            console.log("Ready to process:", fileData.name);
            let allFiles = [fileData.file || fileData];
            if (e.dataTransfer.files.length > 1) {
              const all = await safelyReadFiles(e.dataTransfer.files);
              if (all && all.length > 0) allFiles = all.map(f => f.file || f);
            }
            callback(allFiles, fileData);
          }
        }
      });
    },

    // 21. Toast System
    showToast(message, type = 'info') {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = `toast-item ${type}`;

      const iconMap = {
        success: 'fa-circle-check text-emerald',
        error: 'fa-circle-xmark text-danger',
        warning: 'fa-triangle-exclamation text-orange',
        info: 'fa-circle-info text-cyan'
      };

      toast.innerHTML = `<i class="fa-solid ${iconMap[type] || iconMap.info}"></i> <span>${message}</span>`;
      container.appendChild(toast);

      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
      }, 3500);
    },

    initGlobalShortcuts() {
      window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
          e.preventDefault();
          this.switchTab('convert');
          document.getElementById('convert-file-input').click();
        }
      });
    }
  };

  App.init();
});

