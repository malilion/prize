/* 抽獎轉盤 — shared helpers: formatting, randomness, hashing, CSV, colour, downloads. */
(function (root) {
  'use strict';
  const LW = (root.LW = root.LW || {});

  const $ = (sel, scope) => (scope || document).querySelector(sel);
  const $$ = (sel, scope) => Array.from((scope || document).querySelectorAll(sel));

  function shortcutAction(event, { modalOpen = false } = {}) {
    if (modalOpen || event.defaultPrevented || event.isComposing || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return null;
    if (event.target?.closest?.('input, textarea, select, button, a, [contenteditable], dialog')) return null;
    if (event.key === ' ' || event.key === 'Enter') return 'draw';
    if (event.key === 'f' || event.key === 'F') return 'present';
    if (event.key === 'Escape') return 'close-result';
    return null;
  }

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

  const pad = (n, width = 2) => String(n).padStart(width, '0');
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const mod = (a, m) => ((a % m) + m) % m;

  /* ---------- time & size formatting ---------- */

  const asDate = (d) => (d instanceof Date ? d : new Date(d));

  function formatDateTime(date, { tenths = false } = {}) {
    const d = asDate(date);
    const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    return tenths ? `${base}.${Math.floor(d.getMilliseconds() / 100)}` : base;
  }

  function formatTime(date) {
    const d = asDate(date);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function fileStamp(date = new Date()) {
    const d = asDate(date);
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
      `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  function formatBytes(bytes) {
    if (!(bytes >= 0)) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  }

  /** 7342 → "00:07.3" */
  function formatClock(ms) {
    const t = Math.max(0, Math.floor(ms / 100));
    const s = Math.floor(t / 10);
    return `${pad(Math.floor(s / 60))}:${pad(s % 60)}.${t % 10}`;
  }

  const shortHash = (hash, n = 8) => (hash ? `${hash.slice(0, n)}…${hash.slice(-n)}` : '—');

  /* ---------- randomness: Web Crypto only, never Math.random ---------- */

  function randomUint32() {
    const buf = new Uint32Array(1);
    root.crypto.getRandomValues(buf);
    return buf[0];
  }

  /** Uniform integer in [0, n). Rejection sampling removes modulo bias. */
  function randomInt(n) {
    if (!Number.isInteger(n) || n < 1 || n > 0x100000000) throw new RangeError('randomInt: n out of range');
    const limit = 0x100000000 - (0x100000000 % n);
    let x;
    do { x = randomUint32(); } while (x >= limit);
    return x % n;
  }

  const randomFloat = () => randomUint32() / 0x100000000;

  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — easy to read aloud
  function sessionCode() {
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (i === 3) code += '-';
    }
    return code;
  }

  function uid(prefix = 'id') {
    const bytes = new Uint8Array(8);
    root.crypto.getRandomValues(bytes);
    return `${prefix}_${Array.from(bytes, (b) => pad(b.toString(16))).join('')}`;
  }

  /* ---------- SHA-256: Web Crypto for small inputs, incremental pure JS for large
     recordings and browsers that hide crypto.subtle on file:// pages ---------- */

  const toHex = (bytes) => Array.from(bytes, (b) => pad(b.toString(16))).join('');

  async function toBytes(data) {
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  async function sha256Hex(data) {
    // Web Crypto only accepts a complete buffer. Keep large recordings bounded in memory.
    if (typeof Blob !== 'undefined' && data instanceof Blob && data.size > 32 * 1024 * 1024) {
      const hash = new Sha256();
      const chunkSize = 4 * 1024 * 1024;
      for (let offset = 0; offset < data.size; offset += chunkSize) {
        hash.update(new Uint8Array(await data.slice(offset, offset + chunkSize).arrayBuffer()));
      }
      return hash.digest();
    }
    const bytes = await toBytes(data);
    const subtle = root.crypto && root.crypto.subtle;
    if (subtle) {
      try { return toHex(new Uint8Array(await subtle.digest('SHA-256', bytes))); } catch (_) { /* use fallback */ }
    }
    return sha256Sync(bytes);
  }

  const K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const ror = (x, n) => (x >>> n) | (x << (32 - n));

  class Sha256 {
    constructor() {
      this.length = 0;
      this.block = new Uint8Array(64);
      this.used = 0;
      this.hs = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
      ]);
      this.w = new Uint32Array(64);
    }

    compress(view, off) {
      const hs = this.hs;
      const w = this.w;
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15], b = w[i - 2];
        const s0 = ror(a, 7) ^ ror(a, 18) ^ (a >>> 3);
        const s1 = ror(b, 17) ^ ror(b, 19) ^ (b >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let a = hs[0], b = hs[1], c = hs[2], d = hs[3], e = hs[4], f = hs[5], g = hs[6], h = hs[7];
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
        const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      hs[0] += a; hs[1] += b; hs[2] += c; hs[3] += d;
      hs[4] += e; hs[5] += f; hs[6] += g; hs[7] += h;
    }

    update(bytes) {
      this.length += bytes.length;
      let off = 0;
      if (this.used) {
        const n = Math.min(64 - this.used, bytes.length);
        this.block.set(bytes.subarray(0, n), this.used);
        this.used += n;
        off = n;
        if (this.used === 64) {
          this.compress(new DataView(this.block.buffer), 0);
          this.used = 0;
        }
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      while (off + 64 <= bytes.length) {
        this.compress(view, off);
        off += 64;
      }
      if (off < bytes.length) {
        this.block.set(bytes.subarray(off), 0);
        this.used = bytes.length - off;
      }
    }

    digest() {
      this.block[this.used++] = 0x80;
      if (this.used > 56) {
        this.block.fill(0, this.used);
        this.compress(new DataView(this.block.buffer), 0);
        this.used = 0;
      }
      this.block.fill(0, this.used, 56);
      const view = new DataView(this.block.buffer);
      view.setUint32(56, Math.floor(this.length / 0x20000000));
      view.setUint32(60, (this.length * 8) >>> 0);
      this.compress(view, 0);
      return Array.from(this.hs, (x) => x.toString(16).padStart(8, '0')).join('');
    }
  }

  function sha256Sync(bytes) {
    const hash = new Sha256();
    hash.update(bytes);
    return hash.digest();
  }

  /* ---------- CSV ---------- */

  function csvCell(value) {
    let s = String(value == null ? '' : value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // keep spreadsheets from running names as formulas
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /** UTF-8 with BOM + CRLF, so Excel on Windows and macOS opens Chinese text correctly. */
  const toCSV = (rows) => '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';

  function validWinnersRows(records, sessionId) {
    const rows = [['抽次', '獎項', '獎項代碼', '得獎者', '參加者識別鍵', '抽出時間（UTC）', '場次代碼']];
    for (const record of records) {
      if (record.status !== 'valid') continue;
      rows.push([record.seq, record.prizeName, record.prizeId, record.name, record.key,
        new Date(record.drawnAt).toISOString(), sessionId]);
    }
    return rows;
  }

  function parseCSV(text) {
    text = text.replace(/^\uFEFF/, '');
    const counts = { ',': 0, '\t': 0, ';': 0 };
    let inHeaderQuote = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        if (inHeaderQuote && text[i + 1] === '"') i++;
        else inHeaderQuote = !inHeaderQuote;
      } else if (!inHeaderQuote) {
        if (c === '\r' || c === '\n') break;
        if (Object.hasOwn(counts, c)) counts[c]++;
      }
    }
    const delim = [',', '\t', ';'].reduce((best, d) => counts[d] > counts[best] ? d : best, ',');
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c !== '"') cell += c;
        else if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  /** Decode an uploaded text file: UTF-8 (with/without BOM), UTF-16 (Excel "Unicode text") or Big5. */
  function decodeText(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_) {
      try { text = new TextDecoder('big5').decode(bytes); } catch (__) { text = new TextDecoder().decode(bytes); }
    }
    return text.replace(/^﻿/, '');
  }

  /* ---------- files ---------- */

  function safeFilename(name, max = 60) {
    const cleaned = String(name || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+/, '')
      .trim();
    const chars = Array.from(cleaned);
    return (chars.length > max ? chars.slice(0, max).join('').trim() : cleaned) || '未命名';
  }

  /** Stable across reloads and download flags, while covering the saved session content. */
  function receiptStateHash(state) {
    const canonical = JSON.stringify(state, (key, value) => {
      if (key === 'downloaded' || (key === 'returnToPool' && value === false)) return undefined;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const ordered = {};
        for (const name of Object.keys(value).sort()) ordered[name] = value[name];
        return ordered;
      }
      return value;
    });
    return sha256Sync(new TextEncoder().encode(canonical));
  }

  function normalizeExportReceipt(value, sessionId) {
    if (typeof sessionId !== 'string' || !/^[^\u0000-\u001f\u007f]{1,16}$/.test(sessionId) ||
      !value || typeof value !== 'object' || value.sessionId !== sessionId ||
      typeof value.fileName !== 'string' || value.fileName.length > 120 ||
      !/^[^\\/\u0000-\u001f\u007f]+\.zip$/i.test(value.fileName) ||
      typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256) ||
      typeof value.exportedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.exportedAt) ||
      Number.isNaN(Date.parse(value.exportedAt)) || new Date(value.exportedAt).toISOString() !== value.exportedAt) return null;
    const counts = value.drawCounts;
    if (counts != null && (!counts || typeof counts !== 'object' || Array.isArray(counts) ||
      !['total', 'valid', 'void'].every((key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0) ||
      counts.valid + counts.void > counts.total)) return null;
    if (value.stateSha256 != null && (typeof value.stateSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.stateSha256))) return null;
    return { sessionId, fileName: value.fileName, sha256: value.sha256, exportedAt: value.exportedAt,
      ...(counts == null ? {} : { drawCounts: { total: counts.total, valid: counts.valid, void: counts.void } }),
      ...(value.stateSha256 == null ? {} : { stateSha256: value.stateSha256 }) };
  }

  function exportReceiptText(receipt) {
    return [
      '抽獎憑證包 SHA-256 收據',
      `場次代碼：${receipt.sessionId}`,
      `ZIP 檔名：${receipt.fileName}`,
      `產生時間（UTC）：${receipt.exportedAt}`,
      `ZIP SHA-256：${receipt.sha256}`,
      '',
      '此指紋只對上述 ZIP 檔案有效。請保存原始 ZIP，並在活動時透過獨立管道公布此指紋，供驗證者比對。',
    ].join('\r\n') + '\r\n';
  }

  function recordPage(records, { query = '', status = '', page = 0, pageSize = 50 } = {}) {
    const term = String(query).trim().toLowerCase();
    const selectedStatus = ['valid', 'void', 'aborted'].includes(status) ? status : '';
    const currentPage = Number.isSafeInteger(page) && page >= 0 ? page : 0;
    const size = Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 100) : 50;
    const offset = currentPage * size;
    const exactSequence = /^#(\d+)$/.exec(term);
    const items = [];
    if (!term && !selectedStatus) {
      for (let index = records.length - 1 - offset; index >= 0 && items.length < size; index--) items.push(records[index]);
      return { items, total: records.length, page: currentPage, pageSize: size,
        hasPrevious: currentPage > 0, hasNext: offset + size < records.length };
    }
    let total = 0;
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index];
      if (selectedStatus && record.status !== selectedStatus) continue;
      if (term) {
        const matches = exactSequence ? record.seq === Number(exactSequence[1])
          : String(record.seq).includes(term) || String(record.prizeName || '').toLowerCase().includes(term) ||
            (record.status !== 'pending' && String(record.name || '').toLowerCase().includes(term));
        if (!matches) continue;
      }
      if (total >= offset && items.length < size) items.push(record);
      total++;
    }
    return { items, total, page: currentPage, pageSize: size, hasPrevious: currentPage > 0, hasNext: offset + size < total };
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.hidden = true;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /* ---------- colour: OKLCH tokens → canvas-safe sRGB ---------- */

  function parseColor(input) {
    const s = String(input || '').trim();
    let m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+)(%?)\s*)?\)$/i.exec(s);
    if (m) {
      const L = parseFloat(m[1]) / (m[2] ? 100 : 1);
      const C = parseFloat(m[3]);
      const hue = (parseFloat(m[4]) * Math.PI) / 180;
      const alpha = m[5] ? parseFloat(m[5]) / (m[6] ? 100 : 1) : 1;
      const a = C * Math.cos(hue), b = C * Math.sin(hue);
      const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
      const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
      const ss = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
      const [r, g, bl] = [
        4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * ss,
        -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * ss,
        -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * ss,
      ].map((v) => {
        const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
        return Math.round(Math.min(1, Math.max(0, c)) * 255);
      });
      return { r, g, b: bl, a: alpha };
    }
    m = /^#([0-9a-f]{6})$/i.exec(s);
    if (m) {
      const n = parseInt(m[1], 16);
      return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a: 1 };
    }
    return { r: 128, g: 128, b: 128, a: 1 };
  }

  const rgba = (c, alpha = 1) => `rgba(${c.r}, ${c.g}, ${c.b}, ${+(c.a * alpha).toFixed(3)})`;

  Object.assign(LW, {
    $, $$, shortcutAction, esc, pad, wait, mod,
    formatDateTime, formatTime, fileStamp, formatBytes, formatClock, shortHash,
    randomInt, randomFloat, sessionCode, uid,
    sha256Hex, sha256Sync,
    toCSV, validWinnersRows, parseCSV, decodeText,
    safeFilename, receiptStateHash, normalizeExportReceipt, exportReceiptText, recordPage, download,
    parseColor, rgba,
  });
})(typeof window !== 'undefined' ? window : globalThis);
