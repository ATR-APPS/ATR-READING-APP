/* --------------------------------------------------------------------------
   Respaldo: todos los libros (PDF, portada, progreso, marcadores, texto
   reconocido por OCR) y los ajustes, en un solo archivo .atrbackup.

   Formato:  "ATRBK1" · longitud del índice (uint32) · índice JSON · datos
   El índice dice qué trozo de los datos es cada cosa. Sin compresión: los
   PDF ya vienen comprimidos y así se lee y escribe rápido.
   -------------------------------------------------------------------------- */

import * as db from './db.js';

const MAGIC = 'ATRBK1';
const enc = new TextEncoder();
const dec = new TextDecoder();

export const BACKUP_EXT = '.atrbackup';

/** Arma el respaldo. Devuelve { blob, books, bytes }. */
export async function createBackup(settings) {
  const books = await db.getAll('books');
  const parts = [];
  const entries = [];
  let offset = 0;
  const add = (key, data) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : new Uint8Array(data);
    entries.push({ key, offset, size: bytes.byteLength });
    parts.push(bytes);
    offset += bytes.byteLength;
  };

  const metas = [];
  for (const b of books) {
    const { cover, ...meta } = b;
    metas.push(meta);
    const file = await db.get('files', b.id);
    if (file) add(`file:${b.id}`, file.data || (await file.blob.arrayBuffer()));
    if (cover) add(`cover:${b.id}`, cover instanceof Blob ? await cover.arrayBuffer() : cover);
    // El texto normal se vuelve a sacar solo; el del OCR costó minutos: se guarda.
    const ocr = await db.get('ocr', b.id);
    if (ocr) add(`ocr:${b.id}`, JSON.stringify(ocr));
    const text = await db.get('text', b.id);
    if (text && text.source === 'ocr') add(`text:${b.id}`, JSON.stringify(text));
  }

  const index = enc.encode(JSON.stringify({
    app: 'atr-reading',
    v: 1,
    created: Date.now(),
    settings,
    books: metas,
    entries,
  }));
  const head = new Uint8Array(MAGIC.length + 4);
  head.set(enc.encode(MAGIC), 0);
  new DataView(head.buffer).setUint32(MAGIC.length, index.byteLength);
  const blob = new Blob([head, index, ...parts], { type: 'application/octet-stream' });
  return { blob, books: books.length, bytes: blob.size };
}

/**
 * Restaura un respaldo. Los libros que ya existen no se duplican: se queda
 * el progreso más reciente. Devuelve { added, updated, settings }.
 */
export async function restoreBackup(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (dec.decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) throw new Error('not-backup');
  const len = new DataView(buf).getUint32(MAGIC.length);
  const start = MAGIC.length + 4;
  const index = JSON.parse(dec.decode(bytes.subarray(start, start + len)));
  if (index.app !== 'atr-reading') throw new Error('not-backup');
  const dataStart = start + len;
  const byKey = new Map(index.entries.map((e) => [e.key, e]));
  const slice = (key) => {
    const e = byKey.get(key);
    return e ? buf.slice(dataStart + e.offset, dataStart + e.offset + e.size) : null;
  };
  const json = (key) => {
    const b = slice(key);
    return b ? JSON.parse(dec.decode(b)) : null;
  };

  let added = 0;
  let updated = 0;
  for (const meta of index.books) {
    const cur = await db.get('books', meta.id);
    if (cur) {
      const newer = (meta.openedAt || 0) > (cur.openedAt || 0);
      const marks = mergeMarks(cur.bookmarks, meta.bookmarks);
      if (newer || marks.length !== (cur.bookmarks || []).length) {
        await db.patchBook(meta.id, newer
          ? { progress: meta.progress, openedAt: meta.openedAt, mode: meta.mode, bookmarks: marks }
          : { bookmarks: marks });
        updated++;
      }
      continue;
    }
    const data = slice(`file:${meta.id}`);
    if (!data) continue;
    await db.put('files', { id: meta.id, data });
    await db.put('books', { ...meta, cover: slice(`cover:${meta.id}`), textReady: false });
    const ocr = json(`ocr:${meta.id}`);
    if (ocr) await db.put('ocr', ocr);
    const text = json(`text:${meta.id}`);
    if (text) {
      await db.put('text', text);
      await db.patchBook(meta.id, { textReady: true });
    }
    added++;
  }
  return { added, updated, settings: index.settings, created: index.created };
}

function mergeMarks(a = [], b = []) {
  const map = new Map();
  for (const m of [...a, ...b]) if (!map.has(m.page)) map.set(m.page, m);
  return [...map.values()].sort((x, y) => x.page - y.page);
}
