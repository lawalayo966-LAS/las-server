/**
 * LAS CONVERT — Subtitle Studio SRT Formatter & Exporter
 * Converts Whisper output segments to standard SRT format with sub-second timecodes
 */

/**
 * Convert seconds into SRT timestamp format: HH:MM:SS,mmm
 */
export function formatTimestamp(seconds) {
  const pad = (num, digits = 2) => String(num).padStart(digits, '0');
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const hrs = Math.floor(safeSeconds / 3600);
  const mins = Math.floor((safeSeconds % 3600) / 60);
  const secs = Math.floor(safeSeconds % 60);
  const millis = Math.floor((safeSeconds % 1) * 1000);

  return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(millis, 3)}`;
}

/**
 * Builds standard SRT string from Whisper output segments
 * @param {Array<{start: number, end: number, text: string}>} segments
 * @returns {string}
 */
export function generateSRT(segments = []) {
  let srtContent = '';

  segments.forEach((seg, index) => {
    const startTime = formatTimestamp(seg.start || 0);
    const endTime = formatTimestamp(seg.end || (seg.start != null ? seg.start + 2 : 2));
    const text = (seg.text || seg.word || '').trim();

    srtContent += `${index + 1}\n`;
    srtContent += `${startTime} --> ${endTime}\n`;
    srtContent += `${text}\n\n`;
  });

  return srtContent.trim() + '\n';
}

/**
 * Trigger browser/app download of the .srt file
 */
export function downloadSRTFile(srtText, baseFileName = 'subtitles') {
  const blob = new Blob([srtText], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseFileName.replace(/\.[^/.]+$/, '')}.srt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

if (typeof window !== 'undefined') {
  window.formatTimestamp = formatTimestamp;
  window.generateSRT = generateSRT;
  window.downloadSRTFile = downloadSRTFile;
}
