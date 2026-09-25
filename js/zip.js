/* 抽獎轉盤 — minimal ZIP writer (STORE, no compression: the videos are already compressed).
 * Filenames are UTF-8 (general-purpose flag bit 11) so Chinese names survive on macOS and Windows. */
(function (root) {
  'use strict';
  const LW = (root.LW = root.LW || {});

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes, crc = 0) {
    let c = (crc ^ 0xffffffff) >>> 0;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const CHUNK = 4 * 1024 * 1024;

  async function crc32Blob(blob, onChunk) {
    let crc = 0;
    for (let offset = 0; offset < blob.size; offset += CHUNK) {
      const part = new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer());
      crc = crc32(part, crc);
      if (onChunk) onChunk(part.length);
    }
    return crc;
  }

  function dosTime(date) {
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
      date: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
  }

  /**
   * @param {{name: string, data: Blob|Uint8Array|string}[]} entries  paths use "/" separators
   * @param {{date?: Date, onProgress?: (done: number, total: number) => void}} options
   * @returns {Promise<Blob>} application/zip
   */
  async function makeZip(entries, { date = new Date(), onProgress } = {}) {
    const encoder = new TextEncoder();
    const stamp = dosTime(date);
    const files = entries.map((entry) => {
      const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
      const blob = data instanceof Blob ? data : new Blob([data]);
      return { name: encoder.encode(entry.name), data, blob };
    });
    const totalBytes = files.reduce((sum, f) => sum + f.blob.size, 0);
    let done = 0;
    const report = (n) => { done += n; if (onProgress) onProgress(done, totalBytes); };

    const body = [];
    const central = [];
    let offset = 0;

    for (const file of files) {
      const size = file.blob.size;
      let crc;
      if (file.data instanceof Blob) {
        crc = await crc32Blob(file.blob, report);
      } else {
        crc = crc32(file.data);
        report(size);
      }

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);        // version needed
      local.setUint16(6, 0x0800, true);    // UTF-8 names
      local.setUint16(8, 0, true);         // STORE
      local.setUint16(10, stamp.time, true);
      local.setUint16(12, stamp.date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true);
      local.setUint32(22, size, true);
      local.setUint16(26, file.name.length, true);
      local.setUint16(28, 0, true);
      body.push(local.buffer, file.name, file.blob);

      const entry = new DataView(new ArrayBuffer(46));
      entry.setUint32(0, 0x02014b50, true);
      entry.setUint16(4, 20, true);        // version made by
      entry.setUint16(6, 20, true);        // version needed
      entry.setUint16(8, 0x0800, true);
      entry.setUint16(10, 0, true);
      entry.setUint16(12, stamp.time, true);
      entry.setUint16(14, stamp.date, true);
      entry.setUint32(16, crc, true);
      entry.setUint32(20, size, true);
      entry.setUint32(24, size, true);
      entry.setUint16(28, file.name.length, true);
      entry.setUint32(30, 0, true);        // extra + comment length
      entry.setUint32(34, 0, true);        // disk number + internal attributes
      entry.setUint32(38, 0, true);        // external attributes
      entry.setUint32(42, offset, true);
      central.push(entry.buffer, file.name);

      offset += 30 + file.name.length + size;
      if (offset > 0xffffffff) throw new Error('憑證包超過 4 GB，請分批下載錄影');
    }

    const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...body, ...central, end.buffer], { type: 'application/zip' });
  }

  Object.assign(LW, { crc32, makeZip });
})(typeof window !== 'undefined' ? window : globalThis);
