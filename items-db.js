// Persistent inventory storage for saved "purchased item" records.
//
// Uses IndexedDB rather than localStorage: a saved record can carry several
// full-resolution photos (shelf crop, close-ups, damage shots, later home
// photos), and localStorage's ~5-10MB total quota would fill up after a
// handful of items. IndexedDB's quota is much larger and it's built for
// storing many records with large binary/base64 payloads.
//
// No network involved in save/load — this is exactly what "survives a bad
// connection at the store" requires: the save itself never depends on
// connectivity, only the earlier AI analysis calls did.

(function () {
  "use strict";
  const DB_NAME = "ss-items-db";
  const DB_VERSION = 1;
  const STORE = "items";

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: "id" });
          os.createIndex("status", "status");
          os.createIndex("updatedAt", "updatedAt");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function put(item) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put(item);
          tx.oncomplete = () => resolve(item);
          tx.onerror = () => reject(tx.error);
        })
    );
  }

  function get(id) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readonly");
          const req = tx.objectStore(STORE).get(id);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
        })
    );
  }

  function remove(id) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).delete(id);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        })
    );
  }

  function listAll() {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, "readonly");
          const req = tx.objectStore(STORE).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        })
    );
  }

  function newId() {
    const d = new Date();
    const pad = (n, l) => String(n).padStart(l || 2, "0");
    return (
      "SS-" +
      d.getFullYear() +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) +
      "-" +
      pad(d.getHours()) +
      pad(d.getMinutes()) +
      pad(d.getSeconds())
    );
  }

  window.ItemsDB = { put, get, remove, listAll, newId };
})();
