/**
 * storage.js — All persistence via IndexedDB.
 * Recordings and photos are stored separately.
 * Migrates legacy data from localStorage on first open.
 */

const DB_NAME    = 'gpx-nav-db';
const DB_VERSION = 1;
const SCHEMA_V   = 1;         // increment when data model changes

const STORES = {
  recordings: 'recordings',   // Recording objects (without photo blobs)
  photos:     'photos',       // Blob, keyed by photoKey string
  settings:   'settings',     // Single object, key = 'main'
  meta:       'meta',         // Schema version, migration flags
};

// ── DB open / migrate ──────────────────────────────────────────────────────
let _db = null;

async function openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const old = e.oldVersion;

      if (old < 1) {
        db.createObjectStore(STORES.recordings, { keyPath: 'id' });
        const photos = db.createObjectStore(STORES.photos);   // key-path via put(val,key)
        db.createObjectStore(STORES.settings);
        db.createObjectStore(STORES.meta);
      }
      // Future migrations: if (old < 2) { ... }
    };

    req.onsuccess  = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror    = () => reject(req.error);
    req.onblocked  = () => console.warn('[Storage] DB blocked — close other tabs');
  });
}

function txDone(tx) {
  return new Promise((res, rej) => {
    tx.oncomplete = res;
    tx.onerror    = () => rej(tx.error);
    tx.onabort    = () => rej(new Error('Transaction aborted'));
  });
}

function storeGet(store, key) {
  return new Promise((res, rej) => {
    const r = store.get(key);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}

function storePut(store, value, key) {
  return new Promise((res, rej) => {
    const r = key !== undefined ? store.put(value, key) : store.put(value);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}

function storeGetAll(store) {
  return new Promise((res, rej) => {
    const r = store.getAll();
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}

// ── Recordings ─────────────────────────────────────────────────────────────
/**
 * Save a recording. Photos are extracted to the photos store as Blobs.
 * @param {Object} rec - full recording object (may have stops with .photo as data URL)
 */
export async function saveRecording(rec) {
  const db = await openDB();
  const photoEntries = [];

  const recToSave = {
    ...rec,
    _v: SCHEMA_V,
    stops: (rec.stops || []).map((s) => {
      if (s.photo && s.photo.length > 10) {
        const key = `photo_${rec.id}_stop${s.id}`;
        // Convert data URL to Blob for efficient storage
        const blob = dataURLtoBlob(s.photo);
        photoEntries.push([key, blob]);
        return { ...s, photo: null, photoKey: key };
      }
      return { ...s, photoKey: s.photoKey || null };
    }),
  };

  const tx = db.transaction([STORES.recordings, STORES.photos], 'readwrite');
  storePut(tx.objectStore(STORES.recordings), recToSave);
  for (const [key, blob] of photoEntries) {
    storePut(tx.objectStore(STORES.photos), blob, key);
  }
  await txDone(tx);
}

/**
 * Load a recording by id, resolving photo keys to object URLs.
 */
export async function loadRecording(id) {
  const db = await openDB();
  const tx = db.transaction([STORES.recordings, STORES.photos], 'readonly');
  const rec = await storeGet(tx.objectStore(STORES.recordings), id);
  if (!rec) return null;

  rec.stops = await Promise.all((rec.stops || []).map(async (s) => {
    if (s.photoKey) {
      const blob = await storeGet(tx.objectStore(STORES.photos), s.photoKey);
      return { ...s, photo: blob ? URL.createObjectURL(blob) : null };
    }
    return s;
  }));
  return validateRecording(rec) ? rec : null;
}

/** Load all recordings (without photos — for list display) */
export async function loadAllRecordings() {
  const db  = await openDB();
  const tx  = db.transaction(STORES.recordings, 'readonly');
  const all = await storeGetAll(tx.objectStore(STORES.recordings));
  return all.filter(validateRecording).sort((a, b) =>
    new Date(b.date) - new Date(a.date)
  );
}

export async function deleteRecording(id) {
  const db  = await openDB();
  const rec = await loadRecording(id);
  const tx  = db.transaction([STORES.recordings, STORES.photos], 'readwrite');
  tx.objectStore(STORES.recordings).delete(id);
  if (rec) {
    for (const s of rec.stops || []) {
      if (s.photoKey) tx.objectStore(STORES.photos).delete(s.photoKey);
    }
  }
  await txDone(tx);
}

// ── Settings ───────────────────────────────────────────────────────────────
export async function saveSettings(settings) {
  const db = await openDB();
  const tx = db.transaction(STORES.settings, 'readwrite');
  storePut(tx.objectStore(STORES.settings), { ...settings, _v: SCHEMA_V }, 'main');
  await txDone(tx);
}

export async function loadSettings() {
  const db  = await openDB();
  const tx  = db.transaction(STORES.settings, 'readonly');
  const s   = await storeGet(tx.objectStore(STORES.settings), 'main');
  return s || null;
}

// ── Import / Export ────────────────────────────────────────────────────────
/** Export all recordings as a JSON file download (without photo blobs) */
export async function exportAllJSON() {
  const recs = await loadAllRecordings();
  const json = JSON.stringify({ _v: SCHEMA_V, exportedAt: new Date().toISOString(), recordings: recs }, null, 2);
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = `gpx-nav-export-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
}

/** Import recordings from a JSON file */
export async function importJSON(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  const recs = data.recordings || [];
  let imported = 0;
  for (const r of recs) {
    if (validateRecording(r)) {
      r.id = r.id || generateId();
      await saveRecording(r);
      imported++;
    }
  }
  return imported;
}

// ── Migration from localStorage ────────────────────────────────────────────
export async function migrateFromLocalStorage() {
  const db   = await openDB();
  const tx   = db.transaction(STORES.meta, 'readwrite');
  const done = await storeGet(tx.objectStore(STORES.meta), 'ls_migrated');
  if (done) return 0;

  let migrated = 0;
  try {
    const raw = localStorage.getItem('gpx-nav-recs');
    if (raw) {
      const recs = JSON.parse(raw);
      for (const r of (recs || []).filter(Boolean)) {
        if (!validateRecording(r)) continue;
        r.id   = r.id   || generateId();
        r.date = r.date || new Date().toISOString();
        await saveRecording(r);
        migrated++;
      }
      localStorage.removeItem('gpx-nav-recs');
    }
  } catch (e) {
    console.warn('[Storage] localStorage migration failed:', e.message);
  }

  const tx2 = db.transaction(STORES.meta, 'readwrite');
  storePut(tx2.objectStore(STORES.meta), { at: new Date().toISOString(), count: migrated }, 'ls_migrated');
  await txDone(tx2);

  if (migrated > 0) console.log(`[Storage] Migrated ${migrated} recordings from localStorage`);
  return migrated;
}

// ── Validation ─────────────────────────────────────────────────────────────
export function validateRecording(rec) {
  if (!rec || typeof rec !== 'object')           return false;
  if (!rec.id || !rec.date)                      return false;
  if (!Array.isArray(rec.points))                return false;
  if (rec.points.length < 2)                     return false;
  for (const p of rec.points) {
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number') return false;
    if (Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180)         return false;
  }
  if (!Array.isArray(rec.stops)) return false;
  for (const s of rec.stops) {
    if (typeof s.lat !== 'number' || typeof s.lng !== 'number') return false;
  }
  return true;
}

// ── Utilities ──────────────────────────────────────────────────────────────
export function generateId() {
  return 'rec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

function dataURLtoBlob(dataURL) {
  try {
    const [header, data] = dataURL.split(',');
    const mime  = header.match(/:(.*?);/)[1];
    const bytes = atob(data);
    const arr   = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    return new Blob([arr], { type: mime });
  } catch {
    return null;
  }
}
