/* 抽獎轉盤 — persistence.
 * Store: small app state in localStorage.
 * Vault: per-draw evidence (candidate snapshot + video Blob) in IndexedDB, with an in-memory
 *        fallback when the browser refuses IndexedDB (some private windows / file:// setups). */
(function (root) {
  'use strict';
  const LW = (root.LW = root.LW || {});

  const STATE_KEY = 'lucky-wheel/state/v1';

  const Store = {
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
  const memory = new Map();
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
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
      memory.clear();
      const db = await openDB();
      if (db) {
        try { await run(db, 'readwrite', (s) => s.clear()); } catch (_) { /* nothing left to clear */ }
      }
    },

    /** Replace all evidence in one IndexedDB transaction; used only after archive validation. */
    async replace(records) {
      const db = await openDB();
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
      memory.clear();
      if (!db) for (const record of records) memory.set(record.id, record);
    },

    /** Ask the browser not to evict recordings under storage pressure. */
    async persist() {
      try {
        if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
      } catch (_) { /* optional */ }
      return false;
    },
  };

  Object.assign(LW, { Store, Vault });
})(typeof window !== 'undefined' ? window : globalThis);
