/* --------------------------------------------------------------------------
   Almacenamiento local (IndexedDB). Todo vive en el teléfono.

     books  → ficha del libro: título, autor, portada, progreso, marcadores
     files  → el PDF original (Blob)
     text   → el texto ya reconstruido para el modo «Texto» (caché)
   -------------------------------------------------------------------------- */

const DB_NAME = 'atr-reading';
const DB_VERSION = 2;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of ['books', 'files', 'text', 'ocr']) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function done(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export async function get(name, id) {
  return done((await store(name)).get(id));
}

export async function getAll(name) {
  return done((await store(name)).getAll());
}

export async function put(name, value) {
  return done((await store(name, 'readwrite')).put(value));
}

export async function del(name, id) {
  return done((await store(name, 'readwrite')).delete(id));
}

/** Actualiza campos de una ficha sin pisar el resto. */
export async function patchBook(id, fields) {
  const db = await open();
  const tx = db.transaction('books', 'readwrite');
  const st = tx.objectStore('books');
  const cur = await done(st.get(id));
  if (!cur) return null;
  const next = { ...cur, ...fields };
  st.put(next);
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  return next;
}

export async function deleteBook(id) {
  await Promise.all([del('books', id), del('files', id), del('text', id), del('text', id + '#base'), del('ocr', id)]);
}
