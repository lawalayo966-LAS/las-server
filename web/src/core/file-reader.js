/**
 * LAS CONVERT — Universal Safe File Reader
 * Fixes "Error: File could not be read! Code=-1" on Web, Android WebView, and Capacitor
 * Reads file stream immediately upon selection into memory via Promise-wrapped FileReader.
 */

export async function safelyReadFile(fileInputEvent) {
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

    // Create an in-memory File/Blob instance backed by RAM
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

export async function safelyReadFiles(fileInputEvent) {
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

if (typeof window !== 'undefined') {
  window.safelyReadFile = safelyReadFile;
  window.safelyReadFiles = safelyReadFiles;
}
