/**
 * LAS CONVERT — Subtitles Studio Core Module
 * Handles Subtitle conversions (.srt, .vtt, .ass, .txt), timing offset shifting,
 * and AI video-to-SRT generation via audio extraction & Whisper.
 */

import { generateSRT, downloadSRTFile, formatTimestamp } from './srtFormatter.js';
import { extractAudioFromVideo } from './audioExtractor.js';

export class SubtitleEngine {
  parseSRT(srtText) {
    const blocks = srtText.trim().split(/\n\s*\n/);
    return blocks.map(block => {
      const lines = block.split('\n');
      const index = lines[0];
      const timecode = lines[1] || '';
      const text = lines.slice(2).join('\n');
      return { index, timecode, text };
    });
  }

  convertToVTT(srtText) {
    let vtt = "WEBVTT\n\n";
    // Replace comma with dot in timestamps
    vtt += srtText.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    return vtt;
  }

  convertToASS(srtText) {
    let ass = `[Script Info]
Title: LAS CONVERT Subtitle Stream
ScriptType: v4.00+
Collisions: Normal
PlayDepth: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Outfit,22,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

    const parsed = this.parseSRT(srtText);
    parsed.forEach(item => {
      if (item.timecode) {
        const parts = item.timecode.split('-->');
        if (parts.length === 2) {
          const start = parts[0].trim().replace(',', '.').slice(1, 10);
          const end = parts[1].trim().replace(',', '.').slice(1, 10);
          const text = item.text.replace(/\n/g, '\\N');
          ass += `Dialogue: 0,${start},${end},Default,,0,0,0,,${text}\n`;
        }
      }
    });

    return ass;
  }

  shiftTimecode(srtText, offsetMs) {
    const shiftTimestamp = (ts) => {
      const match = ts.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
      if (!match) return ts;
      let ms = parseInt(match[1], 10) * 3600000 +
               parseInt(match[2], 10) * 60000 +
               parseInt(match[3], 10) * 1000 +
               parseInt(match[4], 10);
      ms = Math.max(0, ms + offsetMs);

      const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
      ms %= 3600000;
      const m = String(Math.floor(ms / 60000)).padStart(2, '0');
      ms %= 60000;
      const s = String(Math.floor(ms / 1000)).padStart(2, '0');
      const milli = String(ms % 1000).padStart(3, '0');

      return `${h}:${m}:${s},${milli}`;
    };

    return srtText.replace(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/g, (match, p1, p2) => {
      return `${shiftTimestamp(p1)} --> ${shiftTimestamp(p2)}`;
    });
  }

  generateSRT(segments) {
    return generateSRT(segments);
  }

  downloadSRTFile(srtText, baseFileName) {
    return downloadSRTFile(srtText, baseFileName);
  }

  async extractAudioFromVideo(videoFile) {
    return extractAudioFromVideo(videoFile);
  }

  /**
   * Complete Video to SRT pipeline:
   * Extracts 16kHz audio, transcribes with Whisper worker, and builds standard SRT
   */
  async generateSRTFromVideo(videoFile, options = {}) {
    const onProgress = options.onProgress || (() => {});
    onProgress(15, 'Extracting 16kHz PCM audio from video container...');
    const float32Data = await extractAudioFromVideo(videoFile);

    onProgress(50, 'Transcribing speech with Whisper AI...');
    if (window.speechEngine && typeof window.speechEngine.transcribeWithWhisper === 'function') {
      // Pass the already-decoded 16 kHz PCM so the video is decoded only once.
      const result = await window.speechEngine.transcribeWithWhisper(float32Data, {
        onProgress: (p) => onProgress(50 + Math.round((p.percent || 0) * 0.4), p.stage || 'Transcribing...')
      });
      const chunks = result.chunks || [];
      const segments = chunks.map((c) => ({
        start: c.timestamp ? c.timestamp[0] : 0,
        end: c.timestamp ? c.timestamp[1] : 2,
        text: c.text
      }));

      onProgress(95, 'Formatting SRT timestamps...');
      const srtText = generateSRT(segments);
      onProgress(100, 'Subtitles ready!');
      return srtText;
    }

    throw new Error('Speech transcription engine not available');
  }
}

export { generateSRT, downloadSRTFile, formatTimestamp, extractAudioFromVideo };

if (typeof window !== 'undefined') {
  window.SubtitleEngine = SubtitleEngine;
  window.subtitleEngine = new SubtitleEngine();
  window.generateSRT = generateSRT;
  window.downloadSRTFile = downloadSRTFile;
  window.extractAudioFromVideo = extractAudioFromVideo;
}
