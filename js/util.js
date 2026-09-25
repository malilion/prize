/* 抽獎轉盤 — shared helpers: formatting, randomness, hashing, CSV, colour, downloads. */
(function (root) {
  'use strict';
  const LW = (root.LW = root.LW || {});

  const $ = (sel, scope) => (scope || document).querySelector(sel);
  const $$ = (sel, scope) => Array.from((scope || document).querySelectorAll(sel));

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

  /* ---------- SHA-256: Web Crypto first, pure-JS fallback for browsers that hide
     crypto.subtle on file:// pages ---------- */

  const toHex = (bytes) => Array.from(bytes, (b) => pad(b.toString(16))).join('');

  async function toBytes(data) {
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  async function sha256Hex(data) {
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

  function sha256Sync(bytes) {
    const len = bytes.length;
    const total = Math.ceil((len + 9) / 64) * 64;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[len] = 0x80;
    const view = new DataView(buf.buffer);
    view.setUint32(total - 8, Math.floor(len / 0x20000000));
    view.setUint32(total - 4, (len * 8) >>> 0);

    const hs = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const w = new Uint32Array(64);
    for (let off = 0; off < total; off += 64) {
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
    return Array.from(hs, (x) => x.toString(16).padStart(8, '0')).join('');
  }

  /* ---------- CSV ---------- */

  function csvCell(value) {
    let s = String(value == null ? '' : value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // keep spreadsheets from running names as formulas
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /** UTF-8 with BOM + CRLF, so Excel on Windows and macOS opens Chinese text correctly. */
  const toCSV = (rows) => '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';

  function parseCSV(text) {
    const firstLine = text.slice(0, text.search(/\r?\n|$/));
    const delim = [',', '\t', ';'].reduce((best, d) =>
      firstLine.split(d).length > firstLine.split(best).length ? d : best, ',');
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
    $, $$, esc, pad, wait, mod,
    formatDateTime, formatTime, fileStamp, formatBytes, formatClock, shortHash,
    randomInt, randomFloat, sessionCode, uid,
    sha256Hex, sha256Sync,
    toCSV, parseCSV, decodeText,
    safeFilename, download,
    parseColor, rgba,
  });
})(typeof window !== 'undefined' ? window : globalThis);
