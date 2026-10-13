/**
 * LAS CONVERT — History Engine Core
 * Tracks conversion history, persists audit records to localStorage, and enables exports.
 */

class HistoryEngine {
  constructor() {
    this.storageKey = 'las_convert_history_v1';
    this.records = this.loadRecords();
  }

  loadRecords() {
    try {
      const data = localStorage.getItem(this.storageKey);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  }

  saveRecords() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.records));
    } catch (e) {
      console.error(e);
    }
  }

  record(item) {
    const record = {
      id: 'rec_' + Date.now(),
      timestamp: new Date().toLocaleTimeString() + ' (' + new Date().toLocaleDateString() + ')',
      name: item.name || 'unnamed',
      inputSize: item.inputSize || 0,
      outputSize: item.outputSize || 0,
      targetFormat: (item.targetFormat || 'mp4').toUpperCase(),
      savings: item.inputSize > item.outputSize 
        ? `${Math.round(((item.inputSize - item.outputSize) / item.inputSize) * 100)}%`
        : '0%',
      status: item.status || 'Success'
    };

    this.records.unshift(record);
    if (this.records.length > 50) this.records.pop();
    this.saveRecords();
    return record;
  }

  getAll() {
    return this.records;
  }

  clear() {
    this.records = [];
    this.saveRecords();
  }

  exportJSON() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(this.records, null, 2));
    const a = document.createElement('a');
    a.setAttribute("href", dataStr);
    a.setAttribute("download", "las_convert_history.json");
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

window.historyEngine = new HistoryEngine();
