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
for (const file of ['js/util.js', 'js/zip.js', 'js/store.js', 'js/evidence.js', 'js/eligibility.js']) {
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), context, { filename: file });
}
const { LW } = context;

test('state store reports a failed browser write', () => {
  context.localStorage = { setItem() { throw new Error('QuotaExceededError'); } };
  assert.equal(LW.Store.save({ records: [] }), false);
  context.localStorage = { setItem() {} };
  assert.equal(LW.Store.save({ records: [] }), true);
});

test('draw gate rejects a second draw while Web Locks holds the session', async () => {
  let occupied = false;
  const gateContext = vm.createContext({
    navigator: { locks: { async request(_id, options, callback) {
      assert.equal(options.ifAvailable, true);
      if (occupied) return callback(null);
      occupied = true;
      try { return await callback({}); } finally { occupied = false; }
    } } },
  });
  gateContext.globalThis = gateContext;
  vm.runInContext(readFileSync(new URL('../js/store.js', import.meta.url), 'utf8'), gateContext);
  let release;
  const first = gateContext.LW.DrawGate.run('SESSION', async (assertHeld) => {
    await assertHeld();
    await new Promise((resolve) => { release = resolve; });
  });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(gateContext.LW.DrawGate.run('SESSION', async () => {}), /另一個分頁操作/);
  release();
  await first;
  await gateContext.LW.DrawGate.run('SESSION', async () => {});
});

test('IndexedDB draw lease prevents a concurrent draw and releases afterward', async () => {
  const stores = new Map();
  const db = {
    objectStoreNames: { contains(name) { return stores.has(name); } },
    createObjectStore(name) { stores.set(name, new Map()); },
    transaction(name) {
      const data = stores.get(name);
      const tx = { oncomplete: null, onerror: null, onabort: null };
      tx.objectStore = () => ({
        get(id) {
          const request = { result: undefined, onsuccess: null };
          queueMicrotask(() => {
            request.result = data.get(id);
            request.onsuccess();
            queueMicrotask(() => tx.oncomplete());
          });
          return request;
        },
        put(value) { data.set(value.id, value); },
        delete(id) { data.delete(id); },
      });
      return tx;
    },
  };
  const gateContext = vm.createContext({
    crypto: webcrypto, Uint8Array, setInterval, clearInterval,
    indexedDB: { open(_name, version) {
      assert.equal(version, 2);
      const request = { result: db };
      queueMicrotask(() => { request.onupgradeneeded(); request.onsuccess(); });
      return request;
    } },
  });
  gateContext.globalThis = gateContext;
  for (const file of ['js/util.js', 'js/store.js']) {
    vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), gateContext);
  }
  let release;
  const first = gateContext.LW.DrawGate.run('SESSION', async (assertHeld) => {
    await assertHeld();
    await new Promise((resolve) => { release = resolve; });
  });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(gateContext.LW.DrawGate.run('SESSION', async () => {}), /另一個分頁操作/);
  release();
  await first;
  await gateContext.LW.DrawGate.run('SESSION', async (assertHeld) => { await assertHeld(); });
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

test('ZIP reader rejects corruption and unsafe filenames', async () => {
  const zip = await LW.makeZip([{ name: '場次/狀態.json', data: '{}' }]);
  assert.equal((await LW.readZip(zip)).size, 1);
  const bytes = new Uint8Array(await zip.arrayBuffer());
  bytes[bytes.indexOf(123)] ^= 1;
  await assert.rejects(LW.readZip(new Blob([bytes])), /校驗失敗/);
  const unsafe = await LW.makeZip([{ name: '場次/../evil.txt', data: 'x' }]);
  await assert.rejects(LW.readZip(unsafe), /不安全/);
});

test('eligibility applies group and per-prize repeat rules', () => {
  const people = LW.parsePeople('甲 | 業務\n乙 | 工程\n甲 | 業務');
  assert.equal(people[2].key, '甲 | 業務#2');
  const records = [{ key: people[0].key, status: 'valid' }];
  assert.equal(LW.eligiblePeople(people, records, { eligibleGroup: '業務', repeatPolicy: 'exclude' }, { allowRepeat: true }).length, 1);
  assert.equal(LW.eligiblePeople(people, records, { eligibleGroup: '業務', repeatPolicy: 'allow' }, { allowRepeat: false }).length, 2);
});

test('Vault replaces evidence when durable storage is unavailable', async () => {
  await LW.Vault.replace([{ id: 'old', candidates: ['甲'], video: null }]);
  assert.equal((await LW.Vault.get('old')).candidates[0], '甲');
  await LW.Vault.replace([{ id: 'new', candidates: ['乙'], video: null }]);
  assert.equal(await LW.Vault.get('old'), null);
  assert.equal((await LW.Vault.get('new')).candidates[0], '乙');
  await assert.rejects(LW.Vault.replace([null]), /id/);
  assert.equal((await LW.Vault.get('new')).candidates[0], '乙');
});

test('session replacement preserves the old state and evidence when saving fails', async () => {
  const records = new Map([['old', { id: 'old', candidates: ['甲'] }]]);
  const vault = {
    async get(id) { return records.get(id) || null; },
    async replace(next) { records.clear(); for (const record of next) records.set(record.id, record); },
  };
  const previous = { records: [{ id: 'old' }], session: { id: 'OLD' } };
  const next = { records: [{ id: 'new' }], session: { id: 'NEW' } };
  const incoming = [{ id: 'new', candidates: ['乙'] }];
  let writes = 0;
  const failedStore = { save() { writes++; return false; } };
  await assert.rejects(LW.replaceSession(previous, next, incoming, { store: failedStore, vault }), /原場次與錄影已保留/);
  assert.equal(writes, 1);
  assert.equal(records.has('old'), true);
  assert.equal(records.has('new'), false);
  const okStore = { save(state) { writes++; assert.equal(state.session.id, 'NEW'); return true; } };
  await LW.replaceSession(previous, next, incoming, { store: okStore, vault });
  assert.equal(records.has('new'), true);
  assert.equal(records.has('old'), false);
  const refusedVault = {
    async get(id) { return records.get(id) || null; },
    async replace() { throw new Error('IndexedDB aborted'); },
  };
  const beforeWriteCount = writes;
  await assert.rejects(LW.replaceSession(next, previous, [{ id: 'old' }], { store: okStore, vault: refusedVault }), /IndexedDB aborted/);
  assert.equal(writes, beforeWriteCount);
  assert.equal(records.has('new'), true);
});

test('a backup before the first draw can be inspected and restored', async () => {
  const state = { v: 1, title: '活動', session: { id: 'EMPTY', createdAt: '2026-09-27T00:00:00.000Z' }, people: '甲', prizes: [], records: [], settings: { allowRepeat: false } };
  const zip = await LW.makeZip([
    { name: '包/抽獎紀錄.json', data: JSON.stringify({ format: 'lucky-wheel-audit/1', event: { title: '活動', sessionId: 'EMPTY', sessionCreatedAt: state.session.createdAt }, prizes: [], participants: ['甲'], participantDetails: [{ name: '甲', group: '', key: '甲' }], draws: [] }) },
    { name: '包/中獎名單.csv', data: LW.toCSV([['序號']]) },
    { name: '包/場次狀態.json', data: JSON.stringify({ format: 'lucky-wheel-session/1', state }) },
    { name: '包/SHA256SUMS.txt', data: '' },
  ]);
  const report = await LW.inspectPackage(zip);
  assert.equal(report.errors.length, 0);
  assert.equal(report.state.session.id, 'EMPTY');
});

test('standalone inspector verifies candidate, winner, video, and restorable state', async () => {
  const video = new Blob([Uint8Array.of(3, 1, 4, 1, 5)]);
  const videoHash = await LW.sha256Hex(video);
  const roster = '甲 | 業務\n乙 | 工程';
  const names = ['甲'];
  const candidateHash = await LW.sha256Hex(names.join('\n'));
  const rule = { eligibleGroup: '業務', repeatPolicy: 'exclude', allowRepeat: false };
  const videoMeta = { state: 'ready', file: 'draw.webm', mime: 'video/webm', sha256: videoHash, size: video.size, durationMs: 1000 };
  const record = { id: 'draw1', seq: 1, prizeId: 'p1', name: '甲', key: '甲 | 業務', index: 0, candidateCount: 1, candidatesHash: candidateHash, status: 'valid', prizeName: '獎品', drawnAt: '2026-09-27T00:00:00.000Z', rule, video: videoMeta };
  const draw = { id: 'draw1', seq: 1, winner: '甲', winnerKey: '甲 | 業務', winnerIndex: 0, candidateCount: 1, candidatesSha256: candidateHash, candidates: names, candidateKeys: ['甲 | 業務'], eligibility: rule, drawnAt: record.drawnAt, status: 'valid', prize: '獎品', video: { file: 'draw.webm', mimeType: 'video/webm', sha256: videoHash, bytes: video.size, durationMs: 1000 } };
  const state = { v: 1, title: '測試', session: { id: 'ABC', createdAt: '2026-09-27T00:00:00.000Z' }, people: roster, prizes: [{ id: 'p1', name: '獎品', qty: 1, eligibleGroup: '業務', repeatPolicy: 'exclude' }], records: [record], settings: { allowRepeat: false } };
  async function archive(editedDraw = draw, includeVideo = true, editAudit = () => {}) {
    const audit = { format: 'lucky-wheel-audit/1', event: { title: '測試', sessionId: 'ABC', sessionCreatedAt: state.session.createdAt }, prizes: [{ id: 'p1', name: '獎品', quantity: 1, eligibleGroup: '業務', repeatPolicy: 'exclude', drawn: 1 }], participants: ['甲', '乙'], participantDetails: [{ name: '甲', group: '業務', key: '甲 | 業務' }, { name: '乙', group: '工程', key: '乙 | 工程' }], draws: [editedDraw] };
    editAudit(audit);
    return LW.makeZip([
      { name: '包/抽獎紀錄.json', data: JSON.stringify(audit) },
      { name: '包/中獎名單.csv', data: LW.toCSV([['序號', '獎項', '中獎者', '抽出時間', '狀態', '備註', '候選人數', '名單指紋（SHA-256）', '錄影檔名', '錄影 SHA-256', '場次代碼'], ['1', '獎品', '甲', '', '有效', '', '1', candidateHash, 'draw.webm', videoHash, 'ABC']]) },
      { name: '包/場次狀態.json', data: JSON.stringify({ format: 'lucky-wheel-session/1', state }) },
      { name: '包/SHA256SUMS.txt', data: includeVideo ? `${videoHash}  錄影/draw.webm\n` : '' },
      ...(includeVideo ? [{ name: '包/錄影/draw.webm', data: video }] : []),
    ]);
  }
  const report = await LW.inspectPackage(await archive());
  assert.equal(report.errors.length, 0);
  assert.equal(report.warnings.length, 0);
  assert.equal(report.state.session.id, 'ABC');
  assert.equal(report.files.get('包/錄影/draw.webm').size, video.size);
  const altered = await LW.inspectPackage(await archive({ ...draw, winner: '乙' }));
  assert.ok(altered.errors.some((error) => error.includes('中獎者')));
  const missing = await LW.inspectPackage(await archive(draw, false));
  assert.equal(missing.errors.length, 0);
  assert.ok(missing.warnings.some((warning) => warning.includes('錄影未包含')));
  const changedPrize = await LW.inspectPackage(await archive(draw, true, (audit) => { audit.prizes[0].quantity = 2; }));
  assert.ok(changedPrize.errors.some((error) => error.includes('獎項清單')));
});
