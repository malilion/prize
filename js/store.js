/* 抽獎轉盤 — persistence.
 * Store: small app state in localStorage.
 * Vault: per-draw evidence (candidate snapshot + video Blob) in IndexedDB, with an in-memory
 *        fallback when the browser refuses IndexedDB (some private windows / file:// setups). */
(function (root) {
  'use strict';
  const LW = (root.LW = root.LW || {});

  const STATE_KEY = 'lucky-wheel/state/v1';

  const Store = {
    stateKey: STATE_KEY,
    read() {
      let raw;
      try {
        raw = localStorage.getItem(STATE_KEY);
      } catch (_) {
        return { status: 'unavailable', raw: null, value: null };
      }
      if (raw === null) return { status: 'empty', raw: null, value: null };
      try { return { status: 'ok', raw, value: JSON.parse(raw) }; }
      catch (_) { return { status: 'corrupt', raw, value: null }; }
    },
    load() {
      const result = Store.read();
      return result.status === 'ok' ? result.value : null;
    },
    validState(raw, version) {
      return !!(raw && typeof raw === 'object' && !Array.isArray(raw) && raw.v === version &&
        raw.session && typeof raw.session.id === 'string' && raw.session.id &&
        Array.isArray(raw.prizes) && Array.isArray(raw.records) &&
        raw.prizes.length <= 1000 && raw.records.length <= 100000 &&
        raw.prizes.every((prize) => prize && typeof prize === 'object' && typeof prize.id === 'string' && prize.id) &&
        raw.records.every((record, index) => record && typeof record === 'object' &&
          typeof record.id === 'string' && record.id && record.seq === index + 1) &&
        new Set(raw.prizes.map((prize) => prize.id)).size === raw.prizes.length &&
        new Set(raw.records.map((record) => record.id)).size === raw.records.length &&
        typeof raw.people === 'string' && raw.people.length <= 2000000 &&
        raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings));
    },
    save(state) {
      try {
        localStorage.setItem(STATE_KEY, JSON.stringify(state));
        return true;
      } catch (_) {
        return false;
      }
    },
    /** Per-viewer conveniences (last open tab, etc.). Never required for correctness. */
    getPref(key, fallback) {
      try {
        const v = localStorage.getItem(`lucky-wheel/pref/${key}`);
        return v == null ? fallback : JSON.parse(v);
      } catch (_) {
        return fallback;
      }
    },
    setPref(key, value) {
      try {
        localStorage.setItem(`lucky-wheel/pref/${key}`, JSON.stringify(value));
        return true;
      } catch (_) {
        return false;
      }
    },
  };

  const DB_NAME = 'lucky-wheel';
  const STORE_NAME = 'draws';
  const LOCK_STORE = 'locks';
  const DRAW_LOCK_MS = 30000;
  let memory = new Map();
  let dbPromise = null;
  let generation = '';
  const generationKey = (id, selected = generation) => selected ? `@${selected}/${id}` : id;

  function openDB() {
    if (dbPromise) return dbPromise;
    const opening = new Promise((resolve) => {
      let settled = false;
      let blockedTimer = null;
      const finish = (db) => {
        if (settled) {
          if (db) db.close();
          return;
        }
        settled = true;
        if (blockedTimer) clearTimeout(blockedTimer);
        resolve(db);
      };
      try {
        const req = indexedDB.open(DB_NAME, 2);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
          if (!req.result.objectStoreNames.contains(LOCK_STORE)) req.result.createObjectStore(LOCK_STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => {
            db.close();
            if (dbPromise === result) {
              dbPromise = null;
              Vault.durable = false;
            }
          };
          finish(db);
        };
        req.onerror = () => finish(null);
        req.onblocked = () => { blockedTimer ||= setTimeout(() => finish(null), 3000); };
      } catch (_) {
        finish(null);
      }
    });
    const result = opening.then((db) => {
      Vault.durable = !!db;
      if (!db && dbPromise === result) dbPromise = null;
      return db;
    });
    dbPromise = result;
    return dbPromise;
  }

  function run(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const req = fn(tx.objectStore(STORE_NAME));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  function lockError() {
    return Object.assign(new Error('此場次正在另一個分頁操作，或無法取得跨分頁鎖定。請關閉其他操作分頁後重試。'), { lockLost: true });
  }

  /** IndexedDB readwrite transactions serialize claims across tabs when Web Locks is absent. */
  function lockTransaction(db, id, owner, operation) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(LOCK_STORE, 'readwrite');
      const store = tx.objectStore(LOCK_STORE);
      const request = store.get(id);
      let accepted = false;
      request.onsuccess = () => {
        const current = request.result;
        const now = Date.now();
        if (operation === 'claim' && (!current || current.expiresAt <= now)) {
          store.put({ id, owner, expiresAt: now + DRAW_LOCK_MS });
          accepted = true;
        } else if (current && current.owner === owner) {
          if (operation === 'renew') store.put({ id, owner, expiresAt: now + DRAW_LOCK_MS });
          if (operation === 'release') store.delete(id);
          accepted = true;
        }
      };
      tx.oncomplete = () => resolve(accepted);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  const DrawGate = {
    async run(sessionId, action) {
      const id = `draw/${sessionId}`;
      if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
        return navigator.locks.request(id, { mode: 'exclusive', ifAvailable: true }, (lock) => {
          if (!lock) throw lockError();
          return action(async () => {});
        });
      }
      const db = await openDB();
      if (!db) throw lockError();
      const owner = LW.uid('lock');
      if (!await lockTransaction(db, id, owner, 'claim')) throw lockError();
      let lost = false;
      const renew = setInterval(() => {
        lockTransaction(db, id, owner, 'renew').then((ok) => { if (!ok) lost = true; }).catch(() => { lost = true; });
      }, DRAW_LOCK_MS / 3);
      try {
        return await action(async () => {
          if (lost || !await lockTransaction(db, id, owner, 'renew')) throw lockError();
        });
      } finally {
        clearInterval(renew);
        try { await lockTransaction(db, id, owner, 'release'); } catch (_) { /* lease expires */ }
      }
    },
  };

  const Vault = {
    /** true once IndexedDB is open; false means evidence lives in memory until downloaded */
    durable: false,
    ready: () => openDB(),
    setGeneration(value) {
      if (value && !/^vault_[0-9a-f]{16}$/.test(value)) throw new Error('無效的錄影世代識別碼');
      generation = value || '';
    },

    async put(record) {
      const stored = { ...record, id: generationKey(record.id) };
      const db = await openDB();
      if (db) {
        try {
          await run(db, 'readwrite', (s) => s.put(stored));
          return;
        } catch (_) {
          Vault.durable = false;
        }
      }
      memory.set(stored.id, stored);
    },

    async get(id) {
      const key = generationKey(id);
      if (memory.has(key)) return { ...memory.get(key), id };
      const db = await openDB();
      if (!db) return null;
      try {
        const stored = await run(db, 'readonly', (s) => s.get(key));
        return stored ? { ...stored, id } : null;
      } catch (_) {
        return null;
      }
    },

    async update(id, patch) {
      const current = (await Vault.get(id)) || { id };
      await Vault.put({ ...current, ...patch });
    },

    async clear() {
      await Vault.replace([]);
    },

    /** Stage a replacement under a new namespace, leaving the active session intact. */
    async stageSession(nextGeneration, records) {
      if (!/^vault_[0-9a-f]{16}$/.test(nextGeneration)) throw new Error('無效的錄影世代識別碼');
      const staged = records.map((record) => {
        if (!record || typeof record.id !== 'string' || !record.id) throw new Error('錄影資料缺少識別碼');
        return { ...record, id: generationKey(record.id, nextGeneration) };
      });
      const db = await openDB();
      if (db) {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          for (const record of staged) store.put(record);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      } else {
        for (const record of staged) memory.set(record.id, record);
      }
    },

    /** Cleanup after the state switch. A crash before this point only leaves orphaned evidence. */
    async removeSession(oldGeneration, records) {
      const keys = records.map((record) => generationKey(record.id, oldGeneration));
      const db = await openDB();
      if (db) {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          for (const key of keys) store.delete(key);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      }
      for (const key of keys) memory.delete(key);
    },

    /** Replace all evidence in one IndexedDB transaction; used only after archive validation. */
    async replace(records) {
      const db = await openDB();
      const replacement = db ? null : new Map(records.map((record) => [record.id, record]));
      if (db) {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          store.clear();
          for (const record of records) store.put(record);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      }
      memory = replacement || new Map();
    },

    /** Ask the browser not to evict recordings under storage pressure. */
    async persist() {
      try {
        if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
      } catch (_) { /* optional */ }
      return false;
    },
  };

  /** Only revive metadata when the staged Blob still matches its recorded digest. */
  async function recoverVideo(snapshot) {
    const video = snapshot?.video;
    const meta = snapshot?.videoMeta;
    if (typeof Blob === 'undefined' || !(video instanceof Blob) || !meta || meta.state !== 'ready') return null;
    const filename = typeof meta.file === 'string' && /^(.+)\.(mp4|webm)$/.exec(meta.file);
    if (!filename || LW.safeFilename(filename[1], 120) !== filename[1] ||
      typeof meta.mime !== 'string' || !meta.mime || meta.mime.length > 80 ||
      !Number.isSafeInteger(meta.size) || meta.size !== video.size ||
      !Number.isSafeInteger(meta.durationMs) || meta.durationMs < 0 || meta.durationMs > 3600000 ||
      typeof meta.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(meta.sha256)) return null;
    try {
      if (await LW.sha256Hex(video) !== meta.sha256) return null;
    } catch (_) { return null; }
    return { state: 'ready', file: meta.file, mime: meta.mime, size: meta.size,
      sha256: meta.sha256, durationMs: meta.durationMs, downloaded: !!meta.downloaded };
  }

  /** Verify the current record against the saved Blob before serving it for playback or download. */
  async function verifiedVideo(snapshot, meta) {
    const video = snapshot?.video;
    if (typeof Blob === 'undefined' || !(video instanceof Blob)) return null;
    if (!meta || meta.state !== 'ready' || video.size !== meta.size ||
      typeof meta.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(meta.sha256) ||
      await LW.sha256Hex(video) !== meta.sha256) {
      throw new Error('錄影內容與中獎紀錄的大小或 SHA-256 不符');
    }
    return video;
  }

  /** Stage evidence before switching state; interruption leaves the previously active session intact. */
  async function replaceSession(previousState, nextState, evidence, { store = Store, vault = Vault } = {}) {
    const oldGeneration = previousState.vaultGeneration || '';
    let nextGeneration;
    do { nextGeneration = LW.uid('vault'); } while (nextGeneration === oldGeneration);
    await vault.stageSession(nextGeneration, evidence);
    nextState.vaultGeneration = nextGeneration;
    if (!store.save(nextState)) {
      try { await vault.removeSession(nextGeneration, evidence); } catch (_) { /* orphaned staging can be removed later */ }
      throw new Error('場次設定無法儲存；原場次與錄影已保留');
    }
    vault.setGeneration(nextGeneration);
    try { await vault.removeSession(oldGeneration, previousState.records); } catch (_) { /* old evidence remains as a backup */ }
  }

  Object.assign(LW, { Store, Vault, DrawGate, replaceSession, recoverVideo, verifiedVideo });
})(typeof window !== 'undefined' ? window : globalThis);
