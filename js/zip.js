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
    if (files.length > 0xffff) throw new Error('憑證包檔案太多，ZIP 格式最多支援 65535 個檔案');
    const localBytes = files.reduce((sum, f) => sum + 30 + f.name.length + f.blob.size, 0);
    const directoryBytes = files.reduce((sum, f) => sum + 46 + f.name.length, 0);
    if (localBytes > 0xffffffff || directoryBytes > 0xffffffff || localBytes + directoryBytes + 22 > 0xffffffff) {
      throw new Error('憑證包超過 4 GB，請分批下載錄影');
    }
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

  /** Read the STORE-only ZIPs produced by this app without loading video bytes into memory. */
  async function readZip(blob) {
    if (!(blob instanceof Blob) || blob.size < 22 || blob.size > 0xffffffff) throw new Error('不是支援的 ZIP 檔案');
    const tailSize = Math.min(blob.size, 65557);
    const tail = new DataView(await blob.slice(blob.size - tailSize).arrayBuffer());
    let end = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === 0x06054b50 && i + 22 + tail.getUint16(i + 20, true) === tail.byteLength) { end = i; break; }
    }
    if (end < 0 || tail.getUint16(end + 4, true) !== 0 || tail.getUint16(end + 6, true) !== 0) throw new Error('ZIP 結尾無效');
    const count = tail.getUint16(end + 10, true);
    const dirSize = tail.getUint32(end + 12, true);
    const dirOffset = tail.getUint32(end + 16, true);
    if (count !== tail.getUint16(end + 8, true) || dirSize > 8 * 1024 * 1024 || dirOffset + dirSize !== blob.size - tailSize + end) throw new Error('ZIP 索引不完整');
    const dir = new DataView(await blob.slice(dirOffset, dirOffset + dirSize).arrayBuffer());
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const files = new Map();
    let pos = 0;
    for (let i = 0; i < count; i++) {
      if (pos + 46 > dir.byteLength || dir.getUint32(pos, true) !== 0x02014b50) throw new Error('ZIP 索引損壞');
      const flags = dir.getUint16(pos + 8, true);
      const method = dir.getUint16(pos + 10, true);
      const crc = dir.getUint32(pos + 16, true);
      const size = dir.getUint32(pos + 20, true);
      const nameLength = dir.getUint16(pos + 28, true);
      const extra = dir.getUint16(pos + 30, true);
      const comment = dir.getUint16(pos + 32, true);
      const localOffset = dir.getUint32(pos + 42, true);
      if (method !== 0 || flags !== 0x0800 || size !== dir.getUint32(pos + 24, true) || pos + 46 + nameLength + extra + comment > dir.byteLength) throw new Error('ZIP 使用不支援的壓縮或索引格式');
      const name = decoder.decode(new Uint8Array(dir.buffer, pos + 46, nameLength));
      if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some((part) => !part || part === '.' || part === '..') || files.has(name)) throw new Error('ZIP 檔名不安全或重複');
      const headerBytes = await blob.slice(localOffset, localOffset + 30 + nameLength).arrayBuffer();
      const header = new DataView(headerBytes);
      if (header.byteLength !== 30 + nameLength || header.getUint32(0, true) !== 0x04034b50 || header.getUint16(6, true) !== flags || header.getUint16(8, true) !== 0 || header.getUint32(14, true) !== crc || header.getUint32(18, true) !== size || header.getUint32(22, true) !== size || header.getUint16(26, true) !== nameLength || header.getUint16(28, true) !== 0 || decoder.decode(new Uint8Array(headerBytes, 30)) !== name) throw new Error('ZIP 檔案標頭與索引不符');
      const start = localOffset + 30 + nameLength;
      if (start + size > dirOffset) throw new Error('ZIP 檔案內容超出範圍');
      const data = blob.slice(start, start + size);
      if (await crc32Blob(data) !== crc) throw new Error(`ZIP 檔案校驗失敗：${name}`);
      files.set(name, data);
      pos += 46 + nameLength + extra + comment;
    }
    if (pos !== dir.byteLength) throw new Error('ZIP 索引長度不符');
    return files;
  }

  Object.assign(LW, { crc32, makeZip, readZip });
})(typeof window !== 'undefined' ? window : globalThis);
