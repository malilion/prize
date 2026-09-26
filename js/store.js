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
    load() {
      try {
        const raw = localStorage.getItem(STATE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (_) {
        return null;
      }
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
      try { localStorage.setItem(`lucky-wheel/pref/${key}`, JSON.stringify(value)); } catch (_) { /* optional */ }
    },
  };

  const DB_NAME = 'lucky-wheel';
  const STORE_NAME = 'draws';
  const LOCK_STORE = 'locks';
  const DRAW_LOCK_MS = 30000;
  let memory = new Map();
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 2);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
          if (!req.result.objectStoreNames.contains(LOCK_STORE)) req.result.createObjectStore(LOCK_STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => {
          req.result.onversionchange = () => req.result.close();
          resolve(req.result);
        };
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    }).then((db) => {
      Vault.durable = !!db;
      return db;
    });
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

    async put(record) {
      const db = await openDB();
      if (db) {
        try {
          await run(db, 'readwrite', (s) => s.put(record));
          return;
        } catch (_) {
          Vault.durable = false;
        }
      }
      memory.set(record.id, record);
    },

    async get(id) {
      if (memory.has(id)) return memory.get(id);
      const db = await openDB();
      if (!db) return null;
      try {
        return (await run(db, 'readonly', (s) => s.get(id))) || null;
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

  /** Swap a complete session; recover the old evidence if the state write is refused. */
  async function replaceSession(previousState, nextState, evidence, { store = Store, vault = Vault } = {}) {
    const previousEvidence = (await Promise.all(previousState.records.map((record) => vault.get(record.id)))).filter(Boolean);
    await vault.replace(evidence);
    if (store.save(nextState)) return;
    try {
      await vault.replace(previousEvidence);
    } catch (error) {
      throw new Error(`場次設定無法儲存，原始錄影回復也失敗：${error.message || error}`);
    }
    throw new Error('場次設定無法儲存；原場次與錄影已保留');
  }

  Object.assign(LW, { Store, Vault, DrawGate, replaceSession });
})(typeof window !== 'undefined' ? window : globalThis);
