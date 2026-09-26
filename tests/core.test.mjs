import assert from 'node:assert/strict';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({
  Blob, TextEncoder, TextDecoder, Uint8Array, Uint32Array, ArrayBuffer, DataView,
  crypto: webcrypto,
});
context.globalThis = context;
for (const file of ['js/util.js', 'js/zip.js', 'js/store.js']) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), context, { filename: file });
}
const { LW } = context;

test('state store reports a failed browser write', () => {
  context.localStorage = { setItem() { throw new Error('QuotaExceededError'); } };
  assert.equal(LW.Store.save({ records: [] }), false);
  context.localStorage = { setItem() {} };
  assert.equal(LW.Store.save({ records: [] }), true);
});

test('SHA-256 matches Node across padding boundaries and large Blob chunks', async () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, 4097, 33 * 1024 * 1024 + 17]) {
    const bytes = randomBytes(size);
    const expected = createHash('sha256').update(bytes).digest('hex');
    assert.equal(LW.sha256Sync(bytes), expected, `sync size ${size}`);
    assert.equal(await LW.sha256Hex(new Blob([bytes])), expected, `Blob size ${size}`);
  }
});

test('large Blob hashing never reads the complete recording at once', async () => {
  class SliceOnlyBlob extends Blob {
    async arrayBuffer() { throw new Error('whole-file read'); }
  }
  const bytes = randomBytes(33 * 1024 * 1024 + 1);
  const expected = createHash('sha256').update(bytes).digest('hex');
  assert.equal(await LW.sha256Hex(new SliceOnlyBlob([bytes])), expected);
});

test('ZIP rejects classic-format overflow before reading video data', async () => {
  const huge = new Blob([]);
  Object.defineProperty(huge, 'size', { value: 0x100000000 });
  await assert.rejects(LW.makeZip([{ name: 'video.mp4', data: huge }]), /4 GB/);
});

test('ZIP stores text and Blob entries with UTF-8 names', async () => {
  const zip = await LW.makeZip([
    { name: '憑證/說明.txt', data: '測試資料' },
    { name: '憑證/錄影/test.mp4', data: new Blob([Uint8Array.of(1, 2, 3)]) },
  ]);
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const decoded = new TextDecoder().decode(bytes);
  assert.equal(new DataView(bytes.buffer).getUint32(0, true), 0x04034b50);
  assert.match(decoded, /憑證\/說明.txt/);
  assert.match(decoded, /憑證\/錄影\/test.mp4/);
});
