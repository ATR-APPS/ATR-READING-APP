/* --------------------------------------------------------------------------
   ATR READING — biblioteca y lector.

   Dos maneras de leer un PDF:
     · Texto    — el texto reconstruido en párrafos: se elige letra, tamaño,
                  interlineado, márgenes y tema, como en Libros de Apple.
     · Original — las páginas tal cual, con zoom (pellizcar o botones).

   El progreso se guarda como «página + fracción» (y en modo Texto también
   como «párrafo + fracción»), así se recupera exacto aunque cambie la letra.
   -------------------------------------------------------------------------- */

import * as db from './db.js';
import { openPdf, readMeta, renderCover, extractText, readOutline } from './pdf.js';
import { buildReflowFromLines, spliceOcrPages } from './reflow.js';
import { ocrPage, stopOcr, OCR_LANGS } from './ocr.js';
import { createBackup, restoreBackup, BACKUP_EXT } from './backup.js';
import { isEpub, readEpub } from './epub.js';

const TEXT_VERSION = 4; // súbelo cuando cambie el reflujo: los libros se vuelven a preparar solos
const $ = (id) => document.getElementById(id);

/* ------------------------------- Ajustes ------------------------------- */

const FONTS = {
  newyork: { label: 'New York', css: 'ui-serif, "New York", Georgia, serif' },
  sf: { label: 'San Francisco', css: '-apple-system, system-ui, "Helvetica Neue", sans-serif' },
  georgia: { label: 'Georgia', css: 'Georgia, serif' },
  palatino: { label: 'Palatino', css: 'Palatino, "Palatino Linotype", "Book Antiqua", serif' },
  charter: { label: 'Charter', css: 'Charter, "Bitstream Charter", Georgia, serif' },
  avenir: { label: 'Avenir Next', css: '"Avenir Next", Avenir, system-ui, sans-serif' },
};

const THEMES = {
  auto: { label: 'Auto' },
  light: { label: 'Blanco', bg: '#ffffff', dark: false },
  sepia: { label: 'Sepia', bg: '#f5ecd9', dark: false },
  gray: { label: 'Gris', bg: '#3a3a3c', dark: true },
  night: { label: 'Noche', bg: '#000000', dark: true },
};

const LINE_HEIGHTS = { tight: 1.4, normal: 1.6, loose: 1.85 };
const MARGINS = { narrow: 16, normal: 26, wide: 40 };

const DEFAULTS = {
  layout: 'pages', // modo Texto: 'pages' = libro paginado · 'scroll' = desplazamiento
  pdfLayout: 'pages', // modo Original: lo mismo, una página del PDF por pantalla
  fontSize: 19,
  font: 'newyork',
  lineHeight: 'normal',
  margins: 'normal',
  justify: true,
  theme: 'auto',
  tapZones: true,
  keepAwake: false,
  zoom: 1,
  pdfColors: true,
};

let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('atr-reading:settings') || '{}')); } catch { /* sin almacenamiento */ }
function saveSettings() {
  try { localStorage.setItem('atr-reading:settings', JSON.stringify(settings)); } catch { /* sin almacenamiento */ }
}

const systemDark = matchMedia('(prefers-color-scheme: dark)');
const effectiveTheme = () =>
  settings.theme === 'auto' ? (systemDark.matches ? 'night' : 'light') : settings.theme;

/* ------------------------------- Utilidades ------------------------------- */

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const haptic = () => { try { navigator.vibrate && navigator.vibrate(8); } catch { /* iOS no vibra */ } };

function fmtSize(bytes) {
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  return (bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
}

async function fileBytes(file) {
  return new Uint8Array(file.data || (await file.blob.arrayBuffer()));
}

function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = () => { clearTimeout(t); fn(); };
  return d;
}

function setThemeColor(c) { $('themeColor').setAttribute('content', c); }

let toastTimer;
function toast(msg, ms = 1600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => { t.hidden = true; }, 250);
  }, ms);
}

/* ------------------------------ Alerta iOS ------------------------------ */

function alertDialog({ title, message = '', input = null, numeric = false, buttons }) {
  return new Promise((resolve) => {
    const wrap = $('alertWrap');
    const box = $('alert');
    box.innerHTML = `
      <div class="alert-text">
        <h3>${esc(title)}</h3>
        ${message ? `<p>${esc(message)}</p>` : ''}
        ${input !== null ? `<input type="text" class="alert-input" value="${esc(input)}" autocomplete="off"${numeric ? ' inputmode="numeric" pattern="[0-9]*"' : ''}>` : ''}
      </div>
      <div class="alert-btns ${buttons.length > 2 ? 'stack' : ''}">
        ${buttons.map((b, i) => `<button type="button" data-i="${i}" class="${b.style || ''}">${esc(b.label)}</button>`).join('')}
      </div>`;
    wrap.hidden = false;
    requestAnimationFrame(() => wrap.classList.add('show'));
    const inp = box.querySelector('input');
    if (inp) setTimeout(() => { inp.focus(); inp.select(); }, 60);
    box.querySelectorAll('button').forEach((btn) => {
      btn.onclick = () => {
        const b = buttons[+btn.dataset.i];
        wrap.classList.remove('show');
        setTimeout(() => { wrap.hidden = true; }, 200);
        resolve({ value: b.value, text: inp ? inp.value : null });
      };
    });
  });
}

/* ------------------------------ Hoja modal ------------------------------ */

let sheetClose = null;
function openSheet(html, { onMount, onClose, cls = '' } = {}) {
  const sheet = $('sheet');
  const scrim = $('scrim');
  $('sheetBody').innerHTML = html;
  sheet.className = 'sheet glass-sheet ' + cls;
  sheet.hidden = scrim.hidden = false;
  document.body.classList.add('sheet-open');
  sheet.style.transform = '';
  requestAnimationFrame(() => { sheet.classList.add('show'); scrim.classList.add('show'); });
  sheetClose = () => {
    sheet.classList.remove('show');
    scrim.classList.remove('show');
    document.body.classList.remove('sheet-open');
    sheet.style.transform = '';
    setTimeout(() => { sheet.hidden = scrim.hidden = true; }, 320);
    sheetClose = null;
    onClose && onClose();
  };
  onMount && onMount($('sheetBody'));
  liquidSegs($('sheetBody'));
}

/* Control segmentado «Liquid Glass»: la opción elegida es una gota que se
   desliza de un botón a otro (en vez de cambiar de golpe). */
let segObserver = null;
function liquidSegs(root) {
  const place = () => {
    for (const seg of root.querySelectorAll('.seg')) {
      let thumb = seg.querySelector(':scope > .seg-thumb');
      if (!thumb) {
        thumb = document.createElement('i');
        thumb.className = 'seg-thumb';
        seg.prepend(thumb);
        thumb.style.transition = 'none';
      }
      const on = seg.querySelector(':scope > button.on');
      if (!on || !on.offsetWidth) { thumb.style.opacity = '0'; continue; }
      thumb.style.opacity = '1';
      thumb.style.transform = `translateX(${on.offsetLeft}px)`;
      thumb.style.width = on.offsetWidth + 'px';
      requestAnimationFrame(() => { thumb.style.transition = ''; });
    }
  };
  place();
  if (segObserver) segObserver.disconnect();
  segObserver = new MutationObserver(place);
  segObserver.observe(root, { subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
}
function closeSheet() { sheetClose && sheetClose(); }
$('scrim').onclick = closeSheet;

// Deslizar la hoja hacia abajo para cerrarla, como en iOS.
(() => {
  const sheet = $('sheet');
  let y0 = null;
  let dy = 0;
  sheet.addEventListener('touchstart', (e) => {
    const body = $('sheetBody');
    const fromGrab = e.target.closest('.grabber, .sheet-head');
    if (!fromGrab && body.scrollTop > 0) return;
    if (e.target.closest('input[type=range], .seg, .stepper')) return;
    y0 = e.touches[0].clientY;
    dy = 0;
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    dy = e.touches[0].clientY - y0;
    if (dy > 0) {
      sheet.style.transition = 'none';
      sheet.style.transform = `translateY(${dy}px)`;
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false });
  sheet.addEventListener('touchend', () => {
    if (y0 === null) return;
    sheet.style.transition = '';
    if (dy > 90) closeSheet();
    else sheet.style.transform = '';
    y0 = null;
  });
})();

// Sin zoom de página entera (el lector maneja su propio pellizco).
document.addEventListener('gesturestart', (e) => e.preventDefault());

/* ------------------------- Preparación de texto ------------------------- */

/** ¿Sirve el texto guardado? (el de OCR y el de EPUB no dependen del reflujo de PDF) */
const textValid = (t) => !!t && (t.v === TEXT_VERSION || t.source === 'ocr' || t.source === 'epub');

const prepProgress = new Map(); // id → 0..1
const prepJobs = new Map(); // id → Promise<textRecord>

function ensureText(id, docGetter) {
  if (prepJobs.has(id)) return prepJobs.get(id);
  const job = (async () => {
    const cached = await db.get('text', id);
    if (textValid(cached)) return cached;
    prepProgress.set(id, 0);
    renderLibrarySoon();
    const meta = await db.get('books', id);
    if (meta && meta.kind === 'epub') {
      // EPUB: el texto sale directo de sus capítulos (no hay PDF que leer).
      try {
        const file = await db.get('files', id);
        const r = await readEpub(file.data, (p) => { prepProgress.set(id, p); updateCardPrep(id); });
        const rec = { id, v: TEXT_VERSION, source: 'epub', blocks: r.blocks, pageStart: r.pageStart, chars: r.chars, toc: r.toc, numPages: r.numPages };
        await db.put('text', rec);
        await db.patchBook(id, { textReady: true, hasText: true });
        return rec;
      } finally {
        prepProgress.delete(id);
        renderLibrarySoon();
      }
    }
    let doc = await docGetter();
    const own = !doc;
    if (own) {
      const file = await db.get('files', id);
      if (!file) throw new Error('Falta el archivo');
      doc = await openPdf(await fileBytes(file));
    }
    try {
      const r = await extractText(doc, (p) => {
        prepProgress.set(id, p);
        updateCardPrep(id);
        if (reader.id === id) showLoading(p);
      });
      let rec = { id, v: TEXT_VERSION, ...r };
      await db.put('text', rec);
      const hasText = r.chars > Math.max(200, r.numPages * 30);
      // Páginas con el texto mal codificado: si son pocas, se corrigen solas con OCR.
      const garbled = hasText ? r.garbled || [] : [];
      const fewGarbled = garbled.length > 0 && garbled.length <= Math.max(3, r.numPages * 0.3);
      await db.patchBook(id, { textReady: true, hasText, garbledMany: garbled.length > 0 && !fewGarbled });
      const ocr = await db.get('ocr', id);
      if (fewGarbled || (ocr && ocr.patch)) {
        await db.put('text', { ...rec, id: id + '#base' });
        if (ocr && ocr.patch) {
          rec = { ...rec, ...spliceOcrPages(rec, ocr.pages), source: 'pdf+ocr' };
          await db.put('text', rec);
        }
        const pending = garbled.filter((p) => !(ocr && ocr.pages[p]));
        if (pending.length) setTimeout(() => startOcr(id, (ocr && ocr.lang) || r.lang, 0, { only: garbled }), 0);
      }
      return rec;
    } finally {
      prepProgress.delete(id);
      if (own) doc.loadingTask.destroy();
      renderLibrarySoon();
    }
  })();
  prepJobs.set(id, job);
  job.catch(() => {}).finally(() => prepJobs.delete(id));
  return job;
}

/* -------------------------- OCR (PDF escaneados) -------------------------- */

const ocrJobs = new Map(); // id → { running, done, total, lang, stop, t0, d0, errors }

function ocrStatus(book) {
  const j = ocrJobs.get(book.id);
  if (j && j.running) return { state: 'running', done: j.done, total: j.total, lang: j.lang, job: j };
  const o = book.ocr;
  if (!o) return { state: 'none' };
  if (o.complete) return { state: 'complete', done: o.total, total: o.total, lang: o.lang };
  return { state: 'paused', done: o.done, total: o.total, lang: o.lang };
}

function ocrEta(j) {
  const did = j.done - j.d0;
  if (did < 2) return '';
  const perPage = (Date.now() - j.t0) / did;
  const min = Math.round(((j.total - j.done) * perPage) / 60000);
  return min < 1 ? 'menos de 1 min' : `≈ ${min} min`;
}

let ocrWake = null;
async function holdOcrWake(on) {
  if (on && !ocrWake && 'wakeLock' in navigator && document.visibilityState === 'visible') {
    try { ocrWake = await navigator.wakeLock.request('screen'); ocrWake.addEventListener('release', () => { ocrWake = null; }); } catch { /* */ }
  } else if (!on && ocrWake) {
    ocrWake.release().catch(() => {});
    ocrWake = null;
  }
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })])
    .finally(() => clearTimeout(t));
}

/** Reconoce las páginas que falten, empezando por `fromPage` (donde vas leyendo). */
async function startOcr(id, lang, fromPage = 0, opts = {}) {
  const prev = ocrJobs.get(id);
  if (prev && prev.running) return;
  const book = await db.get('books', id);
  if (!book) return;
  const n = book.pages;
  let rec = await db.get('ocr', id);
  if (!rec || rec.lang !== lang || rec.pages.length !== n) rec = { id, lang, pages: new Array(n).fill(null) };
  // `only`: corregir sólo esas páginas (texto mal codificado). Sin `only`: todo el libro.
  const only = opts.full ? null : opts.only || (rec.patch && rec.only) || null;
  rec.patch = !!only;
  rec.only = only;
  const want = only || [...Array(n).keys()];
  const order = [];
  for (const p of want) if (p >= fromPage && !rec.pages[p]) order.push(p);
  for (const p of want) if (p < fromPage && !rec.pages[p]) order.push(p);

  const done = want.filter((p) => rec.pages[p]).length;
  const total = want.length;
  const j = { running: true, done, total, lang, stop: false, t0: Date.now(), d0: done, errors: prev ? prev.errors : 0, patch: !!only };
  ocrJobs.set(id, j);
  await db.patchBook(id, { ocr: { lang, done, total, paused: false, complete: done >= total, patch: !!only } });
  notifyOcr(id);
  holdOcrWake(true);

  let doc = null;
  let first = done === 0;
  let pendingSave = 0;
  let lastSave = Date.now();
  try {
    const file = await db.get('files', id);
    doc = await openPdf(await fileBytes(file));
    for (const p of order) {
      if (j.stop) break;
      rec.pages[p] = await withTimeout(ocrPage(doc, p, lang), 180000);
      j.done++;
      j.errors = 0;
      pendingSave++;
      notifyOcr(id);
      if (first || pendingSave >= 4 || Date.now() - lastSave > 20000) {
        await saveOcr(id, rec, j);
        pendingSave = 0;
        lastSave = Date.now();
        if (first) { first = false; if (!only) onFirstOcrText(id); }
      }
    }
    await saveOcr(id, rec, j);
  } catch (err) {
    console.error(err);
    j.errors++;
    await saveOcr(id, rec, j).catch(() => {});
    await stopOcr();
  } finally {
    j.running = false;
    if (doc) doc.loadingTask.destroy();
    if (![...ocrJobs.values()].some((x) => x.running)) { holdOcrWake(false); stopOcr(); }
    notifyOcr(id);
  }
  // Falló a mitad (p. ej. iOS suspendió la app): reintenta solo, sin insistir.
  if (!j.stop && j.done < j.total && j.errors > 0 && j.errors < 3) {
    setTimeout(() => {
      if (document.visibilityState === 'visible') startOcr(id, lang, fromPage, { only });
    }, 3000);
  }
}

async function saveOcr(id, rec, j) {
  await db.put('ocr', rec);
  const old = await db.get('text', id);
  let text;
  const base = rec.patch ? await db.get('text', id + '#base') : null;
  if (base) {
    // Sólo se cambian las páginas corregidas; el resto queda con el texto del PDF.
    text = { ...base, id, v: TEXT_VERSION, source: 'pdf+ocr', ...spliceOcrPages(base, rec.pages) };
  } else {
    const r = buildReflowFromLines(rec.pages);
    text = { id, v: TEXT_VERSION, source: 'ocr', ...r, sizes: old && old.sizes, numPages: rec.pages.length };
  }
  await db.put('text', text);
  const complete = j.done >= j.total;
  const book = await db.patchBook(id, {
    textReady: true,
    hasText: true,
    ocr: { lang: rec.lang, done: j.done, total: j.total, paused: j.stop && !complete, complete, patch: !!base },
  });
  const b = books.find((x) => x.id === id);
  if (b && book) Object.assign(b, { hasText: true, ocr: book.ocr });
  if (reader.id === id) {
    reader.book.hasText = true;
    reader.book.ocr = book && book.ocr;
    refreshReaderText(text);
  }
}

/** Cambia el texto del lector sin mover al lector de su sitio. */
function refreshReaderText(text) {
  if (reader.mode !== 'text' || !reader.text) { reader.text = text; return; }
  const pos = currentPosition();
  const old = reader.text;
  reader.text = text;
  if (pos && pos.block != null) {
    const k = pos.block - old.pageStart[pos.page];
    const idx = text.pageStart[pos.page] + k;
    pos.block = text.blocks[idx] && text.blocks[idx].p === pos.page ? idx : null;
  }
  buildText();
  restorePosition(pos);
  updatePosition();
}

function onFirstOcrText(id) {
  if (reader.id !== id) return;
  if (reader.mode === 'pages') switchMode('text');
  toast('Texto reconocido: ya puedes cambiar la letra', 2600);
}

function notifyOcr(id) {
  updateCardPrep(id);
  const box = document.getElementById('ocrBox');
  if (box && box.dataset.id === id) renderOcrBox(box);
  const seg = document.querySelector('#modeSeg [data-mode="text"]');
  if (seg && reader.id === id && reader.text && reader.book.hasText !== false) seg.disabled = false;
}

/** ¿Va el recuadro de OCR arriba del todo en «Aa»? (cuando es lo primero que importa) */
function ocrTopBox() {
  const b = reader.book;
  if (!reader.text || !b || b.kind === 'epub') return false;
  return b.hasText === false || (b.ocr && !b.ocr.complete) || (b.garbledMany && !b.ocr);
}

function ocrBoxHTML(book) {
  return `<div class="group pad ocr-box" id="ocrBox" data-id="${book.id}"></div>`;
}

function renderOcrBox(box) {
  const book = reader.book;
  if (!book || book.id !== box.dataset.id) return;
  const st = ocrStatus(book);
  const scanned = book.hasText === false || (book.ocr && book.ocr.lang);
  const lang = st.lang || box.dataset.lang || 'spa';
  box.dataset.lang = lang;
  const pct = st.total ? (st.done / st.total) * 100 : 0;
  let html = `<div class="ocr-title">
      <svg viewBox="0 0 24 24"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M8 9h8M8 12h8M8 15h5"/></svg>
      Reconocer texto (OCR)</div>`;
  const patch = !!((st.job && st.job.patch) || (book.ocr && book.ocr.patch));
  if (st.state === 'none') {
    html += `<p class="ocr-desc">${book.hasText === false
      ? 'Este PDF es escaneado: sus páginas son fotos, no texto. ATR READING puede leerlas y convertirlas en texto para que cambies el tamaño de letra, la tipografía y el tema.'
      : book.garbledMany
        ? 'Muchas páginas de este PDF traen el texto mal codificado (sale con letras o signos raros). Reconócelo a partir de la imagen de cada página para leerlo bien.'
        : 'Si el texto de este PDF sale raro o incompleto, puedes reconocerlo de nuevo a partir de la imagen de cada página.'}</p>
      <div class="lbl">Idioma del libro</div>
      <div class="seg small" id="ocrLang">
        ${Object.entries(OCR_LANGS).map(([k, v]) => `<button data-lang="${k}" class="${k === lang ? 'on' : ''}">${v}</button>`).join('')}
      </div>
      <button class="btn-filled wide" id="ocrStart">Reconocer texto</button>
      <p class="ocr-foot">Se hace en el teléfono, sin internet. Tarda unos segundos por página y empieza por donde vas leyendo, así que puedes ir leyendo mientras avanza. Mantén la app abierta.</p>`;
  } else if (st.state === 'running') {
    const eta = ocrEta(st.job);
    if (patch) html += `<p class="ocr-desc">Corrigiendo páginas que venían con el texto mal codificado.</p>`;
    html += `<div class="ocr-bar"><div style="width:${pct.toFixed(1)}%"></div></div>
      <div class="ocr-stat"><span>${st.done} de ${st.total} páginas</span><span>${eta ? eta + ' restantes' : 'calculando…'}</span></div>
      <button class="btn-plain wide" id="ocrPause">Pausar</button>
      <p class="ocr-foot">Mantén la app abierta: si sales, se detiene y sigue cuando vuelvas.</p>`;
  } else if (st.state === 'paused') {
    html += `<div class="ocr-bar"><div style="width:${pct.toFixed(1)}%"></div></div>
      <div class="ocr-stat"><span>En pausa · ${st.done} de ${st.total} páginas</span></div>
      <button class="btn-filled wide" id="ocrResume">Continuar</button>`;
  } else if (patch) {
    html += `<p class="ocr-desc">Se ${st.total === 1 ? 'corrigió 1 página que venía' : `corrigieron ${st.total} páginas que venían`} con el texto mal codificado, leyéndolas de la imagen (${OCR_LANGS[st.lang] || st.lang}).</p>
      <button class="link-btn" id="ocrFull">¿Sigue saliendo raro? Reconocer todo el libro</button>`;
  } else {
    html += `<p class="ocr-desc">Texto reconocido en las ${st.total} páginas (${OCR_LANGS[st.lang] || st.lang}). Si ves palabras raras, es que la imagen original no era muy nítida.</p>`;
  }
  box.innerHTML = html;
  box.querySelectorAll('#ocrLang button').forEach((b) => {
    b.onclick = () => { box.dataset.lang = b.dataset.lang; renderOcrBox(box); };
  });
  const from = () => { const pos = currentPosition(); return pos ? pos.page : 0; };
  const startBtn = box.querySelector('#ocrStart');
  if (startBtn) startBtn.onclick = () => { startOcr(book.id, box.dataset.lang, from(), { full: true }); };
  const fullBtn = box.querySelector('#ocrFull');
  if (fullBtn) fullBtn.onclick = () => { startOcr(book.id, st.lang || 'spa', from(), { full: true }); };
  const resumeBtn = box.querySelector('#ocrResume');
  if (resumeBtn) resumeBtn.onclick = () => { startOcr(book.id, st.lang, from()); };
  const pauseBtn = box.querySelector('#ocrPause');
  if (pauseBtn) pauseBtn.onclick = () => {
    const j = ocrJobs.get(book.id);
    if (j) j.stop = true;
    pauseBtn.disabled = true;
    pauseBtn.textContent = 'Pausando…';
  };
}

/* ------------------------------ Importar ------------------------------ */

let importing = 0;
$('addBtn').onclick = $('emptyAdd').onclick = () => $('fileInput').click();
$('fileInput').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* opcional */ }
  for (const f of files) await importFile(f);
};

async function importFile(file) {
  importing++;
  renderLibrarySoon();
  const id = uid();
  try {
    const buf = await file.arrayBuffer();
    if (isEpub(file.name, buf)) { await importEpub(file, buf, id); return; }
    const doc = await openPdf(new Uint8Array(buf.slice(0)));
    const meta = await readMeta(doc, file.name);
    const cover = await renderCover(doc);
    // ArrayBuffer y no Blob: Safari en modo privado no guarda Blobs en IndexedDB.
    await db.put('files', { id, data: buf });
    await db.put('books', {
      id,
      title: meta.title,
      author: meta.author,
      pages: doc.numPages,
      size: file.size,
      cover: await cover.blob.arrayBuffer(),
      coverRatio: cover.ratio,
      addedAt: Date.now(),
      openedAt: 0,
      progress: null,
      bookmarks: [],
      mode: null,
      textReady: false,
    });
    importing--;
    ensureText(id, async () => doc)
      .catch(() => {})
      .finally(() => doc.loadingTask.destroy());
    await loadLibrary();
  } catch (err) {
    importing--;
    renderLibrarySoon();
    console.error(err);
    const locked = /password/i.test(String(err && (err.name || err.message)));
    await alertDialog({
      title: 'No se pudo abrir',
      message: locked
        ? `«${file.name}» está protegido con contraseña.`
        : `«${file.name}» no parece un PDF ni un EPUB válido.`,
      buttons: [{ label: 'Aceptar', style: 'bold' }],
    });
  }
}

async function importEpub(file, buf, id) {
  try {
    const r = await readEpub(buf.slice(0));
    let cover = r.cover;
    let ratio = 1.5;
    if (cover) {
      try {
        const bmp = await createImageBitmap(new Blob([cover], { type: r.coverType || 'image/jpeg' }));
        ratio = bmp.height / bmp.width;
        bmp.close && bmp.close();
      } catch { cover = null; }
    }
    if (!cover) ({ cover, ratio } = await typeCover(r.title || file.name, r.author));
    await db.put('files', { id, data: buf });
    await db.put('books', {
      id,
      kind: 'epub',
      title: r.title || file.name.replace(/\.epub$/i, ''),
      author: r.author || '',
      pages: r.numPages,
      size: file.size,
      cover,
      coverRatio: ratio,
      addedAt: Date.now(),
      openedAt: 0,
      progress: null,
      bookmarks: [],
      mode: 'text',
      textReady: true,
      hasText: true,
    });
    await db.put('text', { id, v: TEXT_VERSION, source: 'epub', blocks: r.blocks, pageStart: r.pageStart, chars: r.chars, toc: r.toc, numPages: r.numPages });
  } finally {
    importing--;
  }
  await loadLibrary();
}

/** Portada tipográfica (gris, como el resto de la app) para EPUB sin portada. */
async function typeCover(title, author) {
  const W = 360;
  const H = 540;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#3a3a3c');
  grad.addColorStop(1, '#1c1c1e');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#f2f2f7';
  g.textAlign = 'center';
  g.font = '600 34px ui-serif, "New York", Georgia, serif';
  const words = String(title).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (g.measureText(t).width > W - 60 && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  const shown = lines.slice(0, 6);
  shown.forEach((l, i) => g.fillText(l, W / 2, H * 0.36 + i * 42 - (shown.length - 1) * 21));
  if (author) {
    g.fillStyle = 'rgba(235,235,245,0.6)';
    g.font = '400 20px -apple-system, system-ui, sans-serif';
    g.fillText(String(author).slice(0, 40), W / 2, H - 60);
  }
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  return { cover: await blob.arrayBuffer(), ratio: H / W };
}

/* ------------------------------ Biblioteca ------------------------------ */

let books = [];
let editing = false;
const coverURLs = new Map();

function coverURL(b) {
  if (!b.cover) return '';
  if (!coverURLs.has(b.id)) {
    const blob = b.cover instanceof Blob ? b.cover : new Blob([b.cover], { type: 'image/jpeg' });
    coverURLs.set(b.id, URL.createObjectURL(blob));
  }
  return coverURLs.get(b.id);
}

async function loadLibrary() {
  books = await db.getAll('books');
  books.sort((a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt));
  renderLibrary();
  // Libros cuya preparación se cortó (app cerrada a medias).
  for (const b of books) if (!b.textReady && !prepJobs.has(b.id)) ensureText(b.id, async () => null).catch(() => {});
  // OCR que quedó a medias porque se cerró la app: sigue solo.
  for (const b of books) {
    if (b.ocr && !b.ocr.complete && !b.ocr.paused && !ocrJobs.has(b.id)) {
      startOcr(b.id, b.ocr.lang, b.progress ? b.progress.page : 0);  // `only` se recupera del registro
    }
  }
}

function progressLabel(b) {
  if (prepProgress.has(b.id)) return `Preparando ${Math.round(prepProgress.get(b.id) * 100)} %`;
  const o = ocrStatus(b);
  if (o.state === 'running') return `Reconociendo ${Math.round((o.done / o.total) * 100)} %`;
  const pct = b.progress ? b.progress.pct : 0;
  if (!b.openedAt || !pct) return 'Nuevo';
  if (pct >= 0.995) return 'Terminado';
  return `${Math.max(1, Math.round(pct * 100))} %`;
}

function updateCardPrep(id) {
  const el = document.querySelector(`[data-id="${id}"] .card-meta`);
  const b = books.find((x) => x.id === id);
  if (el && b) el.textContent = progressLabel(b);
}

function coverHTML(b) {
  const ratio = clamp(b.coverRatio || 1.4, 0.6, 1.8);
  return `<div class="cover" style="aspect-ratio: 1 / ${ratio.toFixed(3)}">
      ${b.cover ? `<img src="${coverURL(b)}" alt="" loading="lazy">` : ''}
    </div>`;
}

let renderQueued = false;
function renderLibrarySoon() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderLibrary(); });
}

function renderLibrary() {
  const grid = $('grid');
  const empty = !books.length && !importing;
  $('empty').hidden = !empty;
  $('editBtn').style.visibility = books.length ? '' : 'hidden';
  if (!books.length) editing = false;
  $('editBtn').textContent = editing ? 'OK' : 'Editar';
  $('editBtn').classList.toggle('bold', editing);
  $('library').classList.toggle('editing', editing);

  const recent = books.find((b) => b.openedAt && b.progress && b.progress.pct < 0.995);
  $('continueSec').hidden = !recent || editing;
  if (recent) {
    const pg = (recent.progress.page || 0) + 1;
    $('continueCard').dataset.id = recent.id;
    $('continueCard').innerHTML = `
      ${coverHTML(recent)}
      <div class="cc-info">
        <div class="cc-title">${esc(recent.title)}</div>
        ${recent.author ? `<div class="cc-author">${esc(recent.author)}</div>` : ''}
        <div class="cc-progress"><div style="width:${(recent.progress.pct * 100).toFixed(1)}%"></div></div>
        <div class="cc-meta">Página ${pg} de ${recent.pages} · ${Math.round(recent.progress.pct * 100)} %</div>
      </div>
      <svg class="chev" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>`;
  }

  $('allTitle').hidden = !books.length;
  let html = books.map((b) => `
    <div class="card" data-id="${b.id}" role="button" tabindex="0">
      ${coverHTML(b)}
      <button class="del" type="button" aria-label="Eliminar" data-del="${b.id}">
        <svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>
      </button>
      <div class="card-title">${esc(b.title)}</div>
      <div class="card-meta">${progressLabel(b)}</div>
      ${b.progress && b.progress.pct > 0 && b.progress.pct < 0.995 ? `<div class="card-bar"><div style="width:${(b.progress.pct * 100).toFixed(1)}%"></div></div>` : ''}
    </div>`).join('');
  for (let i = 0; i < importing; i++) {
    html += `<div class="card importing"><div class="cover" style="aspect-ratio:1/1.45"><div class="spinner"></div></div><div class="card-title">Importando…</div></div>`;
  }
  grid.innerHTML = html;

  const total = books.reduce((s, b) => s + (b.size || 0), 0);
  $('libFooter').textContent = books.length
    ? `${books.length} ${books.length === 1 ? 'libro' : 'libros'} · ${fmtSize(total)} en este teléfono`
    : '';
  renderBackupNote();
}

/* ------------------------------- Respaldo ------------------------------- */

function lastBackup() {
  try { return +localStorage.getItem('atr-reading:lastBackup') || 0; } catch { return 0; }
}

function ago(ts) {
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d <= 0) return 'hoy';
  if (d === 1) return 'ayer';
  if (d < 30) return `hace ${d} días`;
  const m = Math.floor(d / 30);
  return m === 1 ? 'hace un mes' : `hace ${m} meses`;
}

function renderBackupNote() {
  const last = lastBackup();
  const note = $('backupNote');
  note.classList.toggle('warn', books.length > 0 && (!last || Date.now() - last > 30 * 86400000));
  note.textContent = !books.length
    ? 'Si ya tenías un respaldo, restáuralo aquí para recuperar tus libros.'
    : last
      ? `Último respaldo: ${ago(last)}. Tus libros sólo viven en este teléfono: si borras la app, se pierden.`
      : 'Aún no has hecho un respaldo. Tus libros sólo viven en este teléfono: si borras la app, se pierden.';
}

async function saveFile(file) {
  // iOS: la hoja de compartir tiene «Guardar en Archivos». Si no, descarga.
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return true; } catch (e) { if (e && e.name === 'AbortError') return false; }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

$('backupBtn').onclick = async () => {
  if (!books.length) { toastLib('No hay libros que respaldar'); return; }
  const btn = $('backupBtn');
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Preparando respaldo…';
  let res;
  try {
    res = await createBackup(settings);
  } catch (err) {
    console.error(err);
    await alertDialog({ title: 'No se pudo crear el respaldo', message: 'Puede que no haya espacio suficiente en el teléfono.', buttons: [{ label: 'Aceptar', style: 'bold' }] });
    return;
  } finally {
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Crear respaldo';
  }
  const d = new Date();
  const name = `ATR-READING respaldo ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}${BACKUP_EXT}`;
  const file = new File([res.blob], name, { type: 'application/octet-stream' });
  // iOS sólo deja abrir «Compartir» justo después de un toque: por eso este segundo paso.
  const r = await alertDialog({
    title: 'Respaldo listo',
    message: `${res.books} ${res.books === 1 ? 'libro' : 'libros'} · ${fmtSize(res.bytes)}. Toca «Guardar» y elige «Guardar en Archivos» (por ejemplo en iCloud Drive).`,
    buttons: [{ label: 'Cancelar', value: false }, { label: 'Guardar', value: true, style: 'bold' }],
  });
  if (!r.value) return;
  if (await saveFile(file)) {
    try { localStorage.setItem('atr-reading:lastBackup', String(Date.now())); } catch { /* */ }
    renderBackupNote();
  }
};

$('restoreBtn').onclick = () => $('restoreInput').click();
$('restoreInput').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let res;
  try {
    res = await restoreBackup(file);
  } catch (err) {
    console.error(err);
    await alertDialog({
      title: 'No se pudo restaurar',
      message: err && err.message === 'not-backup'
        ? `Ese archivo no es un respaldo de ATR READING (los respaldos terminan en ${BACKUP_EXT}).`
        : 'El archivo parece dañado o el teléfono no tiene espacio suficiente.',
      buttons: [{ label: 'Aceptar', style: 'bold' }],
    });
    return;
  }
  if (res.settings) { Object.assign(settings, res.settings); saveSettings(); }
  coverURLs.forEach((u) => URL.revokeObjectURL(u));
  coverURLs.clear();
  await loadLibrary();
  const parts = [];
  if (res.added) parts.push(`${res.added} ${res.added === 1 ? 'libro recuperado' : 'libros recuperados'}`);
  if (res.updated) parts.push(`${res.updated} con progreso actualizado`);
  await alertDialog({
    title: 'Respaldo restaurado',
    message: parts.length ? parts.join(' · ') + '.' : 'Ya tenías todos los libros de ese respaldo.',
    buttons: [{ label: 'Aceptar', style: 'bold' }],
  });
};

function toastLib(msg) {
  alertDialog({ title: msg, buttons: [{ label: 'Aceptar', style: 'bold' }] });
}

$('editBtn').onclick = () => { editing = !editing; renderLibrary(); };
$('continueCard').onclick = () => openBook($('continueCard').dataset.id);

// Toque, pulsación larga y borrar en la cuadrícula.
(() => {
  const grid = $('grid');
  let pressTimer = null;
  let longPressed = false;
  let start = null;
  grid.addEventListener('touchstart', (e) => {
    const card = e.target.closest('.card[data-id]');
    if (!card || editing) return;
    longPressed = false;
    start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    pressTimer = setTimeout(() => {
      longPressed = true;
      haptic();
      card.classList.add('pressed');
      setTimeout(() => card.classList.remove('pressed'), 200);
      bookActions(card.dataset.id);
    }, 520);
  }, { passive: true });
  grid.addEventListener('touchmove', (e) => {
    if (!start) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > 8) clearTimeout(pressTimer);
  }, { passive: true });
  grid.addEventListener('touchend', () => { clearTimeout(pressTimer); start = null; });
  grid.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.card[data-id]');
    if (card) { e.preventDefault(); if (!longPressed) bookActions(card.dataset.id); }
  });
  grid.addEventListener('click', (e) => {
    if (longPressed) { longPressed = false; return; }
    const del = e.target.closest('[data-del]');
    if (del) { confirmDelete(del.dataset.del); return; }
    const card = e.target.closest('.card[data-id]');
    if (!card) return;
    if (editing) { bookActions(card.dataset.id); return; }
    openBook(card.dataset.id);
  });
})();

async function confirmDelete(id) {
  const b = books.find((x) => x.id === id);
  if (!b) return;
  const r = await alertDialog({
    title: '¿Eliminar libro?',
    message: `«${b.title}» se borrará de este teléfono junto con su progreso y marcadores.`,
    buttons: [{ label: 'Cancelar', value: false }, { label: 'Eliminar', value: true, style: 'danger' }],
  });
  if (!r.value) return;
  await db.deleteBook(id);
  if (coverURLs.has(id)) { URL.revokeObjectURL(coverURLs.get(id)); coverURLs.delete(id); }
  await loadLibrary();
}

function bookActions(id) {
  const b = books.find((x) => x.id === id);
  if (!b) return;
  openSheet(`
    <div class="sheet-head book-head">
      ${coverHTML(b)}
      <div>
        <div class="bh-title">${esc(b.title)}</div>
        <div class="bh-meta">${b.author ? esc(b.author) + ' · ' : ''}${b.pages} págs. · ${fmtSize(b.size || 0)}</div>
      </div>
    </div>
    <div class="group">
      <button class="row" data-act="open"><span>Leer</span><svg viewBox="0 0 24 24"><path d="M5 5h6a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H5zM19 5h-6a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h6z"/></svg></button>
      <button class="row" data-act="rename"><span>Cambiar título</span><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg></button>
      <button class="row" data-act="reset"><span>Marcar como no leído</span><svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v5h5"/></svg></button>
    </div>
    <div class="group">
      <button class="row danger" data-act="delete"><span>Eliminar</span><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg></button>
    </div>`, {
    cls: 'compact',
    onMount(body) {
      body.querySelectorAll('[data-act]').forEach((btn) => {
        btn.onclick = async () => {
          const act = btn.dataset.act;
          closeSheet();
          if (act === 'open') openBook(id);
          if (act === 'delete') setTimeout(() => confirmDelete(id), 250);
          if (act === 'reset') {
            await db.patchBook(id, { progress: null, openedAt: 0 });
            await loadLibrary();
          }
          if (act === 'rename') {
            setTimeout(async () => {
              const r = await alertDialog({
                title: 'Cambiar título',
                input: b.title,
                buttons: [{ label: 'Cancelar', value: false }, { label: 'Guardar', value: true, style: 'bold' }],
              });
              const t = r.text && r.text.trim();
              if (r.value && t) { await db.patchBook(id, { title: t }); await loadLibrary(); }
            }, 250);
          }
        };
      });
    },
  });
}

// Título pequeño en la barra cuando el grande se esconde al desplazar.
$('libScroll').addEventListener('scroll', () => {
  const s = $('libScroll').scrollTop;
  $('libNav').classList.toggle('scrolled', s > 38);
  $('library').classList.toggle('scrolled', s > 6);
}, { passive: true });

/* ================================ Lector ================================ */

const reader = {
  id: null,
  book: null,
  doc: null,
  text: null,
  mode: 'text',
  blockEls: [],
  pageEls: [],
  observer: null,
  rendered: new Map(), // índice de página → { canvas, task }
  outline: null,
  chrome: false,
  restoring: false,
  wake: null,
};

const rScroll = $('rScroll');
const rText = $('rText');
const rPages = $('rPages');

async function openBook(id) {
  const book = await db.get('books', id);
  const file = await db.get('files', id);
  if (!book || !file) return;
  Object.assign(reader, {
    id, book, text: null, outline: null, blockEls: [], pageEls: [], chrome: false, lastTextPos: null,
  });
  book.openedAt = Date.now();
  db.patchBook(id, { openedAt: book.openedAt });

  $('rTitle').textContent = book.title;
  $('reader').hidden = false;
  $('reader').classList.remove('chrome');
  document.body.classList.add('reading');
  requestAnimationFrame(() => $('reader').classList.add('open'));
  applyReaderLook();
  rText.innerHTML = '';
  rPages.innerHTML = '';
  rScroll.scrollTop = 0;
  rScroll.scrollLeft = 0;
  showLoading(null);

  reader.doc = book.kind === 'epub' ? null : await openPdf(await fileBytes(file));
  if (reader.id !== id) { if (reader.doc) reader.doc.loadingTask.destroy(); return; }

  const cached = await db.get('text', id);
  if (textValid(cached)) reader.text = cached;
  const fresh = await db.get('books', id);
  reader.book.hasText = fresh.hasText;
  reader.book.garbledMany = fresh.garbledMany;
  reader.book.ocr = fresh.ocr;
  const hasText = fresh.hasText !== false;
  reader.mode = book.kind === 'epub' ? 'text' : book.mode || (hasText ? 'text' : 'pages');
  updateWakeLock();

  if (reader.mode === 'text' && !reader.text) {
    try {
      reader.text = await ensureText(id, async () => reader.doc);
    } catch {
      reader.mode = 'pages';
    }
    if (reader.id !== id) return;
    const after = await db.get('books', id);
    reader.book.hasText = after.hasText;
    reader.book.garbledMany = after.garbledMany;
    if (after.hasText === false) {
      reader.mode = 'pages';
      toast('PDF escaneado: toca Aa para reconocer su texto', 3200);
    }
  }
  hideLoading();
  buildMode(book.progress);
  if (!reader.text) ensureText(id, async () => reader.doc).then(async (t) => {
    if (reader.id !== id) return;
    reader.text = t;
    reader.book.hasText = (await db.get('books', id)).hasText;
  }).catch(() => {});
}

function showLoading(p) {
  $('rLoading').hidden = false;
  $('rLoadingText').textContent = p === null ? 'Abriendo…' : 'Preparando el texto…';
  $('rLoadingBar').parentElement.style.visibility = p === null ? 'hidden' : '';
  $('rLoadingBar').style.width = `${Math.round((p || 0) * 100)}%`;
}
function hideLoading() { $('rLoading').hidden = true; }

async function closeReader() {
  saveProgress.flush();
  const id = reader.id;
  reader.id = null;
  teardownPages();
  if (reader.doc) { reader.doc.loadingTask.destroy(); reader.doc = null; }
  releaseWakeLock();
  $('reader').classList.remove('open');
  document.body.classList.remove('reading');
  document.documentElement.dataset.scheme = '';
  setThemeColor(getComputedStyle(document.body).getPropertyValue('--bg').trim() || '#f2f2f7');
  setTimeout(() => {
    if (reader.id) return;
    $('reader').hidden = true;
    rText.innerHTML = '';
  }, 330);
  closeSheet();
  await loadLibrary();
  return id;
}
$('rBack').onclick = closeReader;

/* -------------------------- Apariencia del lector -------------------------- */

function applyReaderLook() {
  const th = effectiveTheme();
  const r = $('reader');
  r.dataset.theme = th;
  document.documentElement.dataset.scheme = 'dark'; // la interfaz es siempre gris oscuro (como ATR BOOK)
  r.style.setProperty('--r-font', FONTS[settings.font].css);
  r.style.setProperty('--r-size', settings.fontSize + 'px');
  r.style.setProperty('--r-lh', LINE_HEIGHTS[settings.lineHeight]);
  r.style.setProperty('--r-margin', MARGINS[settings.margins] + 'px');
  r.classList.toggle('justify', settings.justify);
  r.classList.toggle('pdf-colors', settings.pdfColors);
  r.classList.toggle('paged', isPaged());
  r.classList.toggle('pdf-paged', isPdfPaged());
  if (reader.id) setThemeColor(THEMES[th].bg);
}

/** Cambia algo que mueve el texto sin perder el sitio. */
function relayout(fn) {
  const pos = currentPosition();
  fn();
  applyReaderLook();
  if (reader.mode === 'pages') layoutPages();
  layoutPaged();
  restorePosition(pos);
  updatePosition();
  saveProgress();
}

systemDark.addEventListener('change', () => {
  if (reader.id) applyReaderLook();
  else setThemeColor(getComputedStyle(document.body).getPropertyValue('--bg').trim());
});

/* ------------------------------ Construir ------------------------------ */

function buildMode(pos) {
  $('reader').dataset.mode = reader.mode;
  $('reader').classList.toggle('paged', isPaged());
  $('reader').classList.toggle('pdf-paged', isPdfPaged());
  teardownPages();
  rText.innerHTML = '';
  reader.blockEls = [];
  if (reader.mode === 'text') buildText();
  else buildPages();
  const n = reader.book.pages;
  $('rSlider').max = n;
  restorePosition(pos);
  updatePosition();
  if (isPaged() && pos) {
    // La tipografía puede terminar de cargar después de medir: se repite.
    const id = reader.id;
    const again = () => {
      if (reader.id !== id || !isPaged()) return;
      layoutPaged();
      restorePosition(pos);
      updatePosition();
    };
    requestAnimationFrame(again);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(again);
  }
}

// Títulos que abren capítulo: en modo Páginas empiezan en hoja nueva, como en un libro.
const CHAPTER = /^(cap[ií]tulo|chapter|parte|part|libro|pr[oó]logo|ep[ií]logo|introducci[oó]n|prefacio|pr[eé]face|interludio)\b/i;

function buildText() {
  const { blocks } = reader.text;
  const epub = reader.book.kind === 'epub';
  const parts = new Array(blocks.length);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const opens = i > 0 && b.t === 'h' &&
      ((epub && blocks[i - 1].p !== b.p) || CHAPTER.test(b.s));
    if (b.t === 'x') {
      const range = b.n === 1 ? `Página ${b.p + 1}` : `Páginas ${b.p + 1}–${b.p + b.n}`;
      const job = ocrJobs.get(reader.id);
      parts[i] = `<div class="r-pending" data-i="${i}" data-page="${b.p}">
        <b>${range}</b><span>${job && job.running ? 'Reconociendo el texto…' : 'Aún sin reconocer'} · toca para ver el original</span></div>`;
    } else {
      parts[i] = b.t === 'h' ? `<h2 data-i="${i}"${opens ? ' class="chap"' : ''}>${esc(b.s)}</h2>`
        : b.t === 'n' ? `<p class="r-note" data-i="${i}">${esc(b.s)}</p>`
          : `<p data-i="${i}">${esc(b.s)}</p>`;
    }
  }
  rText.innerHTML = parts.join('') + `<div class="r-end">Fin</div>`;
  reader.blockEls = [...rText.children].slice(0, blocks.length);
  layoutPaged();
}

/* ----------------- Libro paginado (modo Texto → «Páginas») -----------------

   El texto se reparte en columnas CSS del ancho exacto de la pantalla: cada
   columna es una hoja. Pasar de hoja = mover el texto un ancho de pantalla.
   Al cambiar la letra, el navegador vuelve a repartir y recalculamos.       */

const pg = { W: 1, total: 1, cur: 0, starts: [] };
function isPaged() { return reader.mode === 'text' && settings.layout === 'pages'; }

function layoutPaged() {
  if (!isPaged()) {
    rText.style.transform = '';
    rText.style.transition = '';
    return;
  }
  rScroll.scrollTop = 0;
  const W = rScroll.clientWidth;
  pg.W = W;
  $('reader').style.setProperty('--pw', W + 'px');
  // getClientRects y no offsetLeft: Safari devuelve offsetLeft desfasado
  // dentro de columnas justo después de cambiar la letra.
  const base = rText.getBoundingClientRect().left;
  const pageOfEl = (el, fallback) => {
    const r = el.getClientRects()[0];
    return r ? Math.floor((r.left - base + 1) / W) : fallback;
  };
  let prev = 0;
  pg.starts = reader.blockEls.map((el) => (prev = pageOfEl(el, prev)));
  const end = rText.querySelector('.r-end');
  pg.total = Math.max(1, (end ? pageOfEl(end, prev) : prev) + 1);
  pg.cur = clamp(pg.cur, 0, pg.total - 1);
  rText.style.transition = 'none';
  rText.style.transform = `translate3d(${-pg.cur * W}px, 0, 0)`;
}

/** Hoja donde termina el bloque `i` (un párrafo puede cruzar varias). */
function lastPageOf(i) {
  const rects = reader.blockEls[i].getClientRects();
  if (!rects.length) return pg.starts[i];
  const base = rText.getBoundingClientRect().left;
  return Math.floor((rects[rects.length - 1].left - base + 1) / pg.W);
}

function pagedPosition() {
  const starts = pg.starts;
  let j = 0;
  while (j < starts.length && starts[j] < pg.cur) j++; // primer bloque que empieza en esta hoja o después
  // Referencia: el primer párrafo que empieza en esta hoja (estable al cambiar
  // la letra). Si ninguno empieza aquí, el que viene de la hoja anterior.
  const i0 = j < starts.length && starts[j] === pg.cur ? j : j - 1;
  const i = clamp(i0, 0, starts.length - 1);
  const first = starts[i];
  const span = Math.max(1, lastPageOf(i) - first + 1);
  const bfrac = clamp((pg.cur - first) / span, 0, 0.999);
  const pct = pg.total > 1 ? pg.cur / (pg.total - 1) : 1;
  return { page: reader.text.blocks[i].p, frac: 0, block: i, bfrac, pct };
}

function showPage(k, animate = false) {
  pg.cur = clamp(k, 0, pg.total - 1);
  rText.style.transition = animate ? 'transform 0.28s cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none';
  rText.style.transform = `translate3d(${-pg.cur * pg.W}px, 0, 0)`;
  updatePosition();
  if (!reader.restoring) saveProgress();
}

/** Lo que se está paginando ahora (texto o PDF), o null si se desplaza. */
function pager() {
  if (isPaged()) return { el: rText, cur: pg.cur, total: pg.total, W: pg.W, show: showPage };
  if (isPdfPaged()) {
    return { el: rPages, cur: ppg.cur, total: reader.pageEls.length, W: ppg.W, show: showPdfPage, zoomed: settings.zoom > 1.01 };
  }
  return null;
}

// Deslizar el dedo para pasar de hoja.
let swipeClickBlock = 0;
(() => {
  let s = null;
  rScroll.addEventListener('touchstart', (e) => {
    const pgr = pager();
    // Con zoom, el dedo mueve la página ampliada; se pasa de hoja con los bordes.
    if (!pgr || pgr.zoomed || e.touches.length !== 1) { s = null; return; }
    const t = e.touches[0];
    s = { x: t.clientX, y: t.clientY, t: Date.now(), drag: false, dx: 0, pgr };
  }, { passive: true });
  rScroll.addEventListener('touchmove', (e) => {
    if (!s) return;
    if (e.touches.length !== 1) { s = null; return; }
    const t = e.touches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (!s.drag) {
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2) s.drag = true;
      else if (Math.abs(dy) > 10) { s = null; return; } else return;
    }
    if (e.cancelable) e.preventDefault();
    const { pgr } = s;
    const atEdge = (dx > 0 && pgr.cur === 0) || (dx < 0 && pgr.cur === pgr.total - 1);
    s.dx = atEdge ? dx * 0.3 : dx;
    pgr.el.style.transition = 'none';
    pgr.el.style.transform = `translate3d(${-pgr.cur * pgr.W + s.dx}px, 0, 0)`;
  }, { passive: false });
  rScroll.addEventListener('touchend', () => {
    if (!s || !s.drag) { s = null; return; }
    const { pgr } = s;
    const v = s.dx / Math.max(1, Date.now() - s.t);
    let k = pgr.cur;
    if (s.dx < -pgr.W * 0.18 || v < -0.35) k++;
    else if (s.dx > pgr.W * 0.18 || v > 0.35) k--;
    swipeClickBlock = Date.now();
    if (reader.chrome) setChrome(false);
    pgr.show(k, true);
    s = null;
  });
})();

/* ------------------------- Modo Original (páginas) ------------------------- */

function pageSize(i) {
  const sz = reader.text && reader.text.sizes;
  if (sz && sz[i]) return sz[i];
  if (sz && sz[0]) return sz[0];
  return [1, reader.book.coverRatio || 1.414];
}

const ppg = { cur: 0, W: 1, H: 1 }; // modo Original paginado
function isPdfPaged() { return reader.mode === 'pages' && settings.pdfLayout === 'pages'; }

function buildPages() {
  const n = reader.book.pages;
  let html = '';
  // .pgw es la «hoja» de cada página en modo paginado; al desplazar no existe (display: contents).
  for (let i = 0; i < n; i++) html += `<div class="pgw"><div class="pg" data-i="${i}"><span class="pg-n">${i + 1}</span></div></div>`;
  rPages.innerHTML = html;
  reader.pageEls = [...rPages.querySelectorAll('.pg')];
  layoutPages();
}

/** Tamaño en pantalla de una página de `pw`×`ph` puntos para que se vea entera. */
function fitPage(pw, ph) {
  const s = Math.min((ppg.W - 12) / pw, ppg.H / ph) * settings.zoom;
  return [Math.round(pw * s), Math.round(ph * s)];
}

/** Con zoom, una página «nueva» se ve centrada a lo ancho y desde arriba. */
function centerPdfPage(i) {
  const wrap = rPages.children[i];
  if (!wrap) return;
  wrap.scrollLeft = Math.max(0, (wrap.scrollWidth - wrap.clientWidth) / 2);
  wrap.scrollTop = 0;
}

function showPdfPage(k, animate = false) {
  const prev = ppg.cur;
  ppg.cur = clamp(k, 0, Math.max(0, reader.pageEls.length - 1));
  rPages.style.transition = animate ? 'transform 0.28s cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none';
  rPages.style.transform = `translate3d(${-ppg.cur * ppg.W}px, 0, 0)`;
  const wraps = rPages.children;
  if (wraps[prev] && prev !== ppg.cur) wraps[prev].classList.remove('cur');
  if (wraps[ppg.cur]) wraps[ppg.cur].classList.add('cur');
  // La página a la que se llega y sus vecinas (las que asoman al deslizar),
  // centradas. La actual sólo si se cambió de página: si no, se respeta dónde estabas.
  for (const i of [ppg.cur - 1, ppg.cur + 1]) centerPdfPage(i);
  if (prev !== ppg.cur || !animate && reader.restoring) centerPdfPage(ppg.cur);
  // Sólo se dibujan la página actual y sus vecinas: la memoria del iPhone es limitada.
  for (const i of [ppg.cur, ppg.cur + 1, ppg.cur - 1]) if (i >= 0 && i < reader.pageEls.length) renderPage(i);
  for (const i of [...reader.rendered.keys()]) if (Math.abs(i - ppg.cur) > 2) releasePage(i);
  updatePosition();
  if (!reader.restoring) saveProgress();
}

function baseWidth() {
  const w = rScroll.clientWidth - 16;
  return Math.min(w, 900) * settings.zoom;
}

function layoutPages() {
  if (isPdfPaged()) {
    if (reader.observer) { reader.observer.disconnect(); reader.observer = null; }
    rScroll.scrollTop = rScroll.scrollLeft = 0;
    rPages.style.width = '';
    ppg.W = rScroll.clientWidth;
    ppg.H = rPages.clientHeight || rScroll.clientHeight;
    $('reader').style.setProperty('--pw', ppg.W + 'px');
    reader.pageEls.forEach((el, i) => {
      const [w, h] = fitPage(...pageSize(i));
      el.style.width = w + 'px';
      el.style.height = h + 'px';
    });
    rerenderSoon();
    rPages.style.transition = 'none';
    rPages.style.transform = `translate3d(${-ppg.cur * ppg.W}px, 0, 0)`;
    return;
  }
  rPages.style.transform = '';
  if (!reader.observer && reader.pageEls.length) {
    reader.observer = new IntersectionObserver(onPagesVisible, { root: rScroll, rootMargin: '120% 40%' });
    reader.pageEls.forEach((el) => reader.observer.observe(el));
  }
  const w = baseWidth();
  rPages.style.width = Math.max(rScroll.clientWidth, w + 16) + 'px';
  reader.pageEls.forEach((el, i) => {
    const [pw, ph] = pageSize(i);
    el.style.width = w + 'px';
    el.style.height = Math.round((w * ph) / pw) + 'px';
  });
  rerenderSoon();
}

/* Al cambiar el zoom, la página se estira al instante y se redibuja nítida
   cuando se deja de cambiar (si no, cada paso de 5 % la redibujaría). */
const rerenderSoon = debounce(() => {
  for (const [i, r] of reader.rendered) {
    const el = reader.pageEls[i];
    if (el && r.width && Math.abs(r.width - el.clientWidth) > 1) rerenderPage(i);
  }
}, 220);

function onPagesVisible(entries) {
  for (const e of entries) {
    const i = +e.target.dataset.i;
    if (e.isIntersecting) renderPage(i);
    else releasePage(i);
  }
}

let renderChain = Promise.resolve();
function renderPage(i) {
  if (reader.rendered.has(i)) return;
  const slot = { canvas: null, task: null, width: 0, cancelled: false };
  reader.rendered.set(i, slot);
  const doc = reader.doc;
  renderChain = renderChain.then(async () => {
    if (slot.cancelled || doc !== reader.doc) return;
    const el = reader.pageEls[i];
    if (!el) return;
    const page = await doc.getPage(i + 1);
    if (slot.cancelled) return;
    const vp1 = page.getViewport({ scale: 1 });
    if (isPdfPaged()) {
      // Paginado: se ajusta a la página real (puede no medir lo previsto).
      const [w, h] = fitPage(vp1.width, vp1.height);
      const changed = Math.abs(el.offsetWidth - w) > 1;
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      if (changed && i !== ppg.cur) centerPdfPage(i);
    }
    const cssW = el.clientWidth;
    // Ajusta la altura si esta página no tiene el tamaño previsto.
    const realH = Math.round((cssW * vp1.height) / vp1.width);
    if (!isPdfPaged() && Math.abs(realH - el.clientHeight) > 2) {
      const above = el.offsetTop < rScroll.scrollTop;
      const delta = realH - el.clientHeight;
      el.style.height = realH + 'px';
      if (above) rScroll.scrollTop += delta;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    let scale = (cssW / vp1.width) * dpr;
    const maxPx = 7_000_000; // iOS limita la memoria de canvas
    const px = vp1.width * vp1.height * scale * scale;
    if (px > maxPx) scale *= Math.sqrt(maxPx / px);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    slot.task = page.render({ canvasContext: ctx, canvas, viewport: vp });
    try {
      await slot.task.promise;
    } catch {
      canvas.width = canvas.height = 0;
      return;
    }
    if (slot.cancelled) { canvas.width = canvas.height = 0; return; }
    const old = el.querySelector('canvas');
    if (old) { old.width = old.height = 0; old.remove(); }
    el.appendChild(canvas);
    slot.canvas = canvas;
    slot.width = Math.round(cssW);
    if (Math.abs(slot.width - el.clientWidth) > 1) rerenderSoon(); // el zoom cambió mientras se dibujaba
    page.cleanup();
  }).catch(() => {});
}

function releasePage(i) {
  const slot = reader.rendered.get(i);
  if (!slot) return;
  slot.cancelled = true;
  if (slot.task) { try { slot.task.cancel(); } catch { /* ya terminó */ } }
  const el = reader.pageEls[i];
  const c = el && el.querySelector('canvas');
  if (c) { c.width = c.height = 0; c.remove(); }
  reader.rendered.delete(i);
}

function rerenderPage(i) {
  const el = reader.pageEls[i];
  const keep = el && el.querySelector('canvas');
  const slot = reader.rendered.get(i);
  if (slot) { slot.cancelled = true; if (slot.task) try { slot.task.cancel(); } catch { /* */ } }
  reader.rendered.delete(i);
  // El canvas viejo se queda (estirado) hasta que llega el nuevo: sin parpadeo.
  if (keep) keep.dataset.stale = '1';
  renderPage(i);
}

function teardownPages() {
  if (reader.observer) { reader.observer.disconnect(); reader.observer = null; }
  for (const i of [...reader.rendered.keys()]) releasePage(i);
  rPages.innerHTML = '';
  rPages.style.width = '';
  rPages.style.transform = '';
  reader.pageEls = [];
}

/**
 * Cambia el zoom del modo Original dejando en el centro de la pantalla lo
 * mismo que había antes (el zoom va «hacia el centro»).
 */
function zoomAround(z) {
  z = Math.round(clamp(z, 1, 4) * 100) / 100;
  if (isPdfPaged()) {
    const wrap = rPages.children[ppg.cur];
    const el = reader.pageEls[ppg.cur];
    if (!wrap || !el) { settings.zoom = z; saveSettings(); layoutPages(); return; }
    const wr = wrap.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const fx = (wr.width / 2 - (er.left - wr.left)) / er.width;
    const fy = (wr.height / 2 - (er.top - wr.top)) / er.height;
    settings.zoom = z;
    saveSettings();
    layoutPages();
    const er2 = el.getBoundingClientRect();
    const ox = er2.left - wr.left + wrap.scrollLeft;
    const oy = er2.top - wr.top + wrap.scrollTop;
    wrap.scrollLeft = ox + fx * er2.width - wrap.clientWidth / 2;
    wrap.scrollTop = oy + fy * er2.height - wrap.clientHeight / 2;
  } else {
    const fx = (rScroll.scrollLeft + rScroll.clientWidth / 2) / Math.max(1, rPages.offsetWidth);
    const fy = (rScroll.scrollTop + rScroll.clientHeight / 2) / Math.max(1, rPages.offsetHeight);
    settings.zoom = z;
    saveSettings();
    layoutPages();
    rScroll.scrollLeft = fx * rPages.offsetWidth - rScroll.clientWidth / 2;
    rScroll.scrollTop = fy * rPages.offsetHeight - rScroll.clientHeight / 2;
  }
  updatePosition();
  saveProgress();
}

// Pellizcar para hacer zoom en modo Original (eventos de gesto de Safari).
(() => {
  let startZoom = 1;
  let active = false;
  const target = () => (isPdfPaged() ? reader.pageEls[ppg.cur] : rPages);
  rScroll.addEventListener('gesturestart', (e) => {
    if (reader.mode !== 'pages') return;
    e.preventDefault();
    startZoom = settings.zoom;
    active = true;
    const el = target();
    if (!el) return;
    // El efecto visual del pellizco también crece desde el centro de la pantalla.
    if (isPdfPaged()) {
      const wr = rPages.children[ppg.cur].getBoundingClientRect();
      const er = el.getBoundingClientRect();
      el.style.transformOrigin = `${wr.width / 2 - (er.left - wr.left)}px ${wr.height / 2 - (er.top - wr.top)}px`;
    } else {
      el.style.transformOrigin = `${rScroll.scrollLeft + rScroll.clientWidth / 2}px ${rScroll.scrollTop + rScroll.clientHeight / 2}px`;
    }
  });
  rScroll.addEventListener('gesturechange', (e) => {
    if (reader.mode !== 'pages' || !active) return;
    e.preventDefault();
    const z = clamp(startZoom * e.scale, 1, 4);
    const el = target();
    if (el) el.style.transform = `scale(${z / startZoom})`;
  });
  rScroll.addEventListener('gestureend', (e) => {
    if (reader.mode !== 'pages' || !active) return;
    e.preventDefault();
    active = false;
    const el = target();
    if (el) el.style.transform = '';
    zoomAround(Math.round(clamp(startZoom * e.scale, 1, 4) * 20) / 20);
  });
})();

/* --------------------------- Posición y progreso --------------------------- */

/** Último elemento cuyo borde superior está por encima de `y`. */
function findAt(els, y) {
  let lo = 0;
  let hi = els.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (els[mid].offsetTop <= y) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function currentPosition() {
  if (!reader.id) return null;
  const y = rScroll.scrollTop;
  if (isPaged() && reader.blockEls.length) return pagedPosition();
  if (isPdfPaged() && reader.pageEls.length) {
    const n = reader.pageEls.length;
    return { page: ppg.cur, frac: 0, pct: n > 1 ? ppg.cur / (n - 1) : 1 };
  }
  if (reader.mode === 'text' && reader.blockEls.length) {
    const i = findAt(reader.blockEls, y);
    const el = reader.blockEls[i];
    const bfrac = clamp((y - el.offsetTop) / Math.max(1, el.offsetHeight), 0, 1);
    const page = reader.text.blocks[i].p;
    const max = rScroll.scrollHeight - rScroll.clientHeight;
    const pct = max > 0 ? clamp(rScroll.scrollTop / max, 0, 1) : 0;
    return { page, frac: 0, block: i, bfrac, pct };
  }
  if (reader.mode === 'pages' && reader.pageEls.length) {
    const i = findAt(reader.pageEls, y);
    const el = reader.pageEls[i];
    const frac = clamp((y - el.offsetTop) / Math.max(1, el.offsetHeight), 0, 1);
    const max = rScroll.scrollHeight - rScroll.clientHeight;
    const pct = max > 0 && rScroll.scrollTop >= max - 2 ? 1 : (i + frac) / reader.pageEls.length;
    return { page: i, frac, pct };
  }
  return null;
}

function restorePosition(pos) {
  reader.restoring = true;
  if (!pos) {
    rScroll.scrollTop = 0;
    if (isPaged()) showPage(0);
    if (isPdfPaged()) showPdfPage(0);
  } else if (reader.mode === 'text' && reader.blockEls.length) {
    let i;
    let f;
    if (pos.block != null && pos.block < reader.blockEls.length && reader.text.blocks[pos.block].p === pos.page) {
      i = pos.block; f = pos.bfrac || 0;
    } else {
      i = Math.min(reader.text.pageStart[clamp(pos.page || 0, 0, reader.text.pageStart.length - 1)], reader.blockEls.length - 1);
      f = 0;
    }
    i = Math.max(0, i);
    const el = reader.blockEls[i];
    if (isPaged()) {
      const first = pg.starts[i];
      const span = Math.max(1, lastPageOf(i) - first + 1);
      showPage(first + Math.min(span - 1, Math.floor(f * span + 1e-6)));
    } else {
      rScroll.scrollTop = el.offsetTop + f * el.offsetHeight;
    }
  } else if (isPdfPaged() && reader.pageEls.length) {
    showPdfPage(pos.page || 0);
  } else if (reader.mode === 'pages' && reader.pageEls.length) {
    const el = reader.pageEls[clamp(pos.page || 0, 0, reader.pageEls.length - 1)];
    rScroll.scrollTop = el.offsetTop + (pos.frac || 0) * el.offsetHeight;
  }
  chromeAnchor = rScroll.scrollTop;
  requestAnimationFrame(() => { reader.restoring = false; });
}

function goToPage(p) {
  restorePosition({ page: p, frac: 0 });
  updatePosition();
  saveProgress();
}

const saveProgress = debounce(() => {
  if (!reader.id) return;
  const pos = currentPosition();
  if (!pos) return;
  reader.book.progress = pos;
  db.patchBook(reader.id, { progress: pos, mode: reader.mode });
}, 600);

function updatePosition() {
  const pos = currentPosition();
  if (!pos) return;
  const paged = isPaged();
  const n = paged ? pg.total : reader.book.pages;
  const p = paged ? pg.cur + 1 : pos.page + 1;
  if (+slider.max !== n) slider.max = n;
  if (!sliding) slider.value = p;
  setSliderFill();
  // En un EPUB desplazándose, la unidad es el capítulo (no tiene páginas fijas).
  $('rPos').textContent = `${!paged && reader.book.kind === 'epub' ? 'Capítulo' : 'Página'} ${p} de ${n}`;
  const left = n - p;
  $('rLeft').textContent = pos.pct >= 0.995 ? 'Terminado' : left === 0 ? 'Última página' : `${Math.round(pos.pct * 100)} % · quedan ${left}`;
  $('rMini').textContent = `${p} / ${n}`;
  updateMarkBtn(pos.page);
}

let chromeAnchor = 0;
rScroll.addEventListener('scroll', () => {
  if (!reader.id) return;
  updatePosition();
  if (!reader.restoring) {
    saveProgress();
    if (reader.chrome && Math.abs(rScroll.scrollTop - chromeAnchor) > 40) setChrome(false);
  }
}, { passive: true });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    for (const [id, j] of ocrJobs) if (!j.running && !j.stop && j.done < j.total) startOcr(id, j.lang, 0);
  }
  if (document.visibilityState === 'hidden') saveProgress.flush();
  else updateWakeLock();
});
window.addEventListener('pagehide', () => saveProgress.flush());

/* ------------------------- Barras, toques y deslizador ------------------------- */

function setChrome(on) {
  reader.chrome = on;
  chromeAnchor = rScroll.scrollTop;
  $('reader').classList.toggle('chrome', on);
}

rScroll.addEventListener('click', (e) => {
  if (!reader.id) return;
  const pend = e.target.closest('.r-pending');
  if (pend) {
    reader.lastTextPos = currentPosition();
    switchMode('pages', { page: +pend.dataset.page, frac: 0 });
    return;
  }
  if (Date.now() - swipeClickBlock < 400) return;
  // Si hay texto seleccionado, este toque sólo quita la selección (como en iOS).
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) { sel.removeAllRanges(); return; }
  const x = e.clientX / window.innerWidth;
  // Bordes: página anterior / siguiente. Centro: muestra u oculta las herramientas.
  if (!reader.chrome && settings.tapZones && (x < 0.22 || x > 0.78)) {
    turn(x < 0.22 ? -1 : 1);
    return;
  }
  setChrome(!reader.chrome);
});

function turn(dir) {
  if (isPaged()) { showPage(pg.cur + dir, true); return; }
  if (isPdfPaged()) { showPdfPage(ppg.cur + dir, true); return; }
  const lh = reader.mode === 'text' ? settings.fontSize * LINE_HEIGHTS[settings.lineHeight] : 40;
  const step = rScroll.clientHeight - lh * 2 - 30;
  rScroll.scrollBy({ top: dir * step, behavior: 'smooth' });
}

let sliding = false;
const slider = $('rSlider');
function setSliderFill() {
  const pct = ((slider.value - 1) / Math.max(1, slider.max - 1)) * 100;
  slider.style.setProperty('--fill', pct + '%');
}
slider.addEventListener('input', () => {
  sliding = true;
  setSliderFill();
  $('rPos').textContent = `Ir a la página ${slider.value} de ${slider.max}`;
});
slider.addEventListener('change', () => {
  sliding = false;
  sliderJump(+slider.value);
});

/** Ir a la posición `n` del deslizador (1…max): hoja del libro o página del PDF. */
function sliderJump(n) {
  n = clamp(Math.round(n), 1, +slider.max);
  if (isPaged()) showPage(n - 1);
  else goToPage(n - 1);
}

/* Arrastre fino, como en las barras de video del iPhone: mientras arrastras,
   cuanto más subes el dedo, más despacio avanza el deslizador. */
const SCRUB_SPEEDS = [
  [60, 1, 'Sube el dedo para más precisión'],
  [130, 0.5, 'Media velocidad'],
  [210, 0.25, 'Un cuarto de velocidad'],
  [Infinity, 0.08, 'Arrastre fino'],
];
function showScrub(v, label) {
  slider.value = Math.round(v);
  setSliderFill();
  $('rPos').textContent = `Ir a la página ${Math.round(v)} de ${slider.max}`;
  $('rLeft').textContent = label;
}
(() => {
  let t = null;
  const THUMB = 22; // ancho del botón del deslizador
  slider.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    const r = slider.getBoundingClientRect();
    const x = e.touches[0].clientX;
    const max = +slider.max;
    const track = Math.max(1, r.width - THUMB);
    const thumbX = r.left + THUMB / 2 + ((slider.value - 1) / Math.max(1, max - 1)) * track;
    let value = +slider.value;
    // Si no se toca el botón del deslizador, salta a donde está el dedo.
    if (Math.abs(x - thumbX) > 26) value = 1 + clamp((x - r.left - THUMB / 2) / track, 0, 1) * (max - 1);
    t = { lastX: x, value, perPx: (max - 1) / track, top: r.top };
    sliding = true;
    showScrub(value, SCRUB_SPEEDS[0][2]);
  }, { passive: false });
  slider.addEventListener('touchmove', (e) => {
    if (!t) return;
    e.preventDefault();
    const touch = e.touches[0];
    const up = Math.max(0, t.top - touch.clientY);
    const [, factor, label] = SCRUB_SPEEDS.find(([lim]) => up < lim);
    t.value = clamp(t.value + (touch.clientX - t.lastX) * t.perPx * factor, 1, +slider.max);
    t.lastX = touch.clientX;
    showScrub(t.value, label);
  }, { passive: false });
  const end = () => {
    if (!t) return;
    const v = t.value;
    t = null;
    sliding = false;
    sliderJump(v);
  };
  slider.addEventListener('touchend', end);
  slider.addEventListener('touchcancel', end);
})();

// Tocar «Página X de N»: escribir el número exacto.
$('rPos').addEventListener('click', async () => {
  const max = +slider.max;
  const r = await alertDialog({
    title: 'Ir a la página',
    message: `Escribe un número del 1 al ${max}.`,
    input: String(slider.value),
    numeric: true,
    buttons: [{ label: 'Cancelar', value: false }, { label: 'Ir', value: true, style: 'bold' }],
  });
  const n = parseInt(r.text, 10);
  if (r.value && n >= 1) sliderJump(Math.min(n, max));
});

/* ------------------------------- Marcadores ------------------------------- */

function updateMarkBtn(page) {
  const marks = (reader.book && reader.book.bookmarks) || [];
  $('rMark').classList.toggle('on', marks.some((m) => m.page === page));
}

$('rMark').onclick = async () => {
  const pos = currentPosition();
  if (!pos) return;
  const marks = [...(reader.book.bookmarks || [])];
  const k = marks.findIndex((m) => m.page === pos.page);
  if (k >= 0) {
    marks.splice(k, 1);
    toast('Marcador eliminado');
  } else {
    marks.push({ page: pos.page, at: Date.now(), snippet: snippetAt(pos) });
    marks.sort((a, b) => a.page - b.page);
    toast(`Página ${pos.page + 1} marcada`);
  }
  haptic();
  reader.book.bookmarks = marks;
  await db.patchBook(reader.id, { bookmarks: marks });
  updateMarkBtn(pos.page);
};

function snippetAt(pos) {
  if (!reader.text) return '';
  const i = pos.block != null ? pos.block : reader.text.pageStart[pos.page];
  const b = reader.text.blocks[i];
  return b ? b.s.slice(0, 110) : '';
}

/* --------------------------------- Índice --------------------------------- */

$('rToc').onclick = async () => {
  if (!reader.outline) {
    reader.outline = reader.book.kind === 'epub'
      ? (reader.text && reader.text.toc) || []
      : reader.doc ? await readOutline(reader.doc) : [];
  }
  const epub = reader.book.kind === 'epub';
  let outline = reader.outline;
  let fromHeadings = false;
  if (!outline.length && reader.text) {
    outline = reader.text.blocks
      .filter((b) => b.t === 'h' && b.s.length > 1 && b.s.length < 90)
      .map((b) => ({ title: b.s, page: b.p, depth: 0 }));
    fromHeadings = true;
  }
  const pos = currentPosition();
  const cur = pos ? pos.page : 0;
  let curIdx = -1;
  outline.forEach((o, i) => { if (o.page <= cur) curIdx = i; });

  const marks = reader.book.bookmarks || [];
  const tocHTML = outline.length
    ? `<div class="group list">${outline.map((o, i) => `
        <button class="row toc d${o.depth} ${i === curIdx ? 'current' : ''}" data-page="${o.page}">
          <span class="toc-t">${esc(o.title)}</span><span class="toc-p">${epub ? '' : o.page + 1}</span>
        </button>`).join('')}</div>
       ${fromHeadings ? '<p class="note">Este PDF no trae índice; estos son los títulos detectados en el texto.</p>' : ''}`
    : '<p class="placeholder">Este PDF no trae índice.</p>';
  const marksHTML = marks.length
    ? `<div class="group list">${marks.map((m) => `
        <div class="row mark" data-page="${m.page}">
          <div class="mark-t"><b>${epub ? 'Capítulo' : 'Página'} ${m.page + 1}</b>${m.snippet ? `<span>${esc(m.snippet)}…</span>` : ''}</div>
          <button class="mark-del" data-del="${m.page}" aria-label="Quitar">
            <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>`).join('')}</div>`
    : '<p class="placeholder">Sin marcadores.<br>Toca <svg class="inline" viewBox="0 0 24 24"><path d="M7 4h10v16l-5-4-5 4z"/></svg> arriba para marcar la página actual.</p>';

  openSheet(`
    <div class="sheet-head">
      <div class="seg" id="tocSeg">
        <button class="on" data-tab="toc">Índice</button>
        <button data-tab="marks">Marcadores</button>
      </div>
    </div>
    <div id="tabToc">${tocHTML}</div>
    <div id="tabMarks" hidden>${marksHTML}</div>`, {
    cls: 'tall',
    onMount(body) {
      body.querySelectorAll('#tocSeg button').forEach((b) => {
        b.onclick = () => {
          body.querySelectorAll('#tocSeg button').forEach((x) => x.classList.toggle('on', x === b));
          body.querySelector('#tabToc').hidden = b.dataset.tab !== 'toc';
          body.querySelector('#tabMarks').hidden = b.dataset.tab !== 'marks';
        };
      });
      body.addEventListener('click', async (e) => {
        const del = e.target.closest('[data-del]');
        if (del) {
          const pg = +del.dataset.del;
          reader.book.bookmarks = (reader.book.bookmarks || []).filter((m) => m.page !== pg);
          await db.patchBook(reader.id, { bookmarks: reader.book.bookmarks });
          del.closest('.row').remove();
          updateMarkBtn(currentPosition().page);
          return;
        }
        const row = e.target.closest('[data-page]');
        if (!row) return;
        closeSheet();
        setChrome(false);
        goToPage(+row.dataset.page);
      });
      const curEl = body.querySelector('.row.current');
      if (curEl) setTimeout(() => curEl.scrollIntoView({ block: 'center' }), 30);
    },
  });
};

/* ---------------------------- Cambiar de modo ---------------------------- */

function switchMode(mode, at) {
  if (mode === reader.mode) { if (at) goToPage(at.page); return; }
  let pos = at || currentPosition();
  if (!at) {
    if (reader.mode === 'text') reader.lastTextPos = pos;
    else if (reader.lastTextPos && pos && reader.lastTextPos.page === pos.page) pos = reader.lastTextPos;
  }
  reader.mode = mode;
  const body = document.getElementById('sheetBody');
  body.querySelectorAll('#modeSeg button').forEach((x) => x.classList.toggle('on', x.dataset.mode === mode));
  const t = body.querySelector('#textOpts');
  const pg = body.querySelector('#pageOpts');
  if (t) t.hidden = mode !== 'text';
  if (pg) pg.hidden = mode !== 'pages';
  buildMode(pos);
  saveProgress();
}

/* ----------------------------- Hoja «Aa» ----------------------------- */

$('rAa').onclick = () => {
  const textAvailable = reader.text && reader.book.hasText !== false;
  openSheet(`
    <div class="sheet-head">
      <div class="seg" id="modeSeg">
        <button data-mode="text" class="${reader.mode === 'text' ? 'on' : ''}" ${textAvailable ? '' : 'disabled'}>Texto</button>
        <button data-mode="pages" class="${reader.mode === 'pages' ? 'on' : ''}" ${reader.book.kind === 'epub' ? 'disabled' : ''}>Original</button>
      </div>
    </div>
    ${!reader.text ? '<p class="note">El modo Texto estará disponible en cuanto termine de prepararse el libro.</p>' : ''}
    ${ocrTopBox() ? ocrBoxHTML(reader.book) : ''}

    <div id="textOpts" ${reader.mode === 'text' ? '' : 'hidden'}>
      <div class="seg small layout-seg" data-key="layout">
        <button data-v="pages">Páginas</button><button data-v="scroll">Desplazamiento</button>
      </div>
      <div class="group">
        <div class="stepper">
          <button data-step="-1" aria-label="Letra más pequeña"><span style="font-size:15px">A</span></button>
          <div class="stepper-val" id="sizeVal">${settings.fontSize}</div>
          <button data-step="1" aria-label="Letra más grande"><span style="font-size:24px">A</span></button>
        </div>
      </div>

      <div class="group fonts">
        ${Object.entries(FONTS).map(([k, f]) => `
          <button class="row font ${settings.font === k ? 'on' : ''}" data-font="${k}" style="font-family:${f.css.replace(/"/g, '&quot;')}">
            <span>${f.label}</span>
            <svg class="check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
          </button>`).join('')}
      </div>

      <div class="group pad">
        <div class="lbl">Interlineado</div>
        <div class="seg small" data-key="lineHeight">
          <button data-v="tight">Compacto</button><button data-v="normal">Normal</button><button data-v="loose">Amplio</button>
        </div>
        <div class="lbl">Márgenes</div>
        <div class="seg small" data-key="margins">
          <button data-v="narrow">Estrechos</button><button data-v="normal">Normales</button><button data-v="wide">Amplios</button>
        </div>
      </div>

      <div class="group">
        <label class="row switch-row"><span>Justificar texto</span><input type="checkbox" class="switch" data-flag="justify" ${settings.justify ? 'checked' : ''}></label>
      </div>
      ${!ocrTopBox() && reader.book.kind !== 'epub'
        ? (reader.book.ocr ? ocrBoxHTML(reader.book) : '<button class="link-btn" id="ocrOffer">¿El texto sale raro? Reconocerlo con OCR</button>')
        : ''}
    </div>

    <div id="pageOpts" ${reader.mode === 'pages' ? '' : 'hidden'}>
      <div class="seg small layout-seg" data-key="pdfLayout">
        <button data-v="pages">Páginas</button><button data-v="scroll">Desplazamiento</button>
      </div>
      <div class="group">
        <div class="stepper">
          <button data-zoom="-1" aria-label="Alejar"><svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg></button>
          <div class="stepper-val" id="zoomVal">${Math.round(settings.zoom * 100)} %</div>
          <button data-zoom="1" aria-label="Acercar"><svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12"/></svg></button>
        </div>
      </div>
      <p class="note">También puedes pellizcar la página para acercar.</p>
      <div class="group">
        <label class="row switch-row"><span>Adaptar colores al tema</span><input type="checkbox" class="switch" data-flag="pdfColors" ${settings.pdfColors ? 'checked' : ''}></label>
      </div>
    </div>

    <div class="group pad">
      <div class="lbl">Tema</div>
      <div class="themes">
        ${Object.entries(THEMES).map(([k, t]) => `
          <button class="theme t-${k} ${settings.theme === k ? 'on' : ''}" data-theme="${k}">
            <span class="swatch">Aa</span><span class="tname">${t.label}</span>
          </button>`).join('')}
      </div>
    </div>

    <div class="group">
      <label class="row switch-row"><span>Tocar los bordes para avanzar</span><input type="checkbox" class="switch" data-flag="tapZones" ${settings.tapZones ? 'checked' : ''}></label>
      <label class="row switch-row"><span>Mantener la pantalla encendida</span><input type="checkbox" class="switch" data-flag="keepAwake" ${settings.keepAwake ? 'checked' : ''}></label>
    </div>`, {
    cls: 'aa-sheet',
    onMount(body) {
      const sync = () => {
        body.querySelectorAll('.seg[data-key]').forEach((s) => {
          s.querySelectorAll('button').forEach((b) => b.classList.toggle('on', settings[s.dataset.key] === b.dataset.v));
        });
        body.querySelectorAll('[data-font]').forEach((b) => b.classList.toggle('on', settings.font === b.dataset.font));
        body.querySelectorAll('[data-theme]').forEach((b) => b.classList.toggle('on', settings.theme === b.dataset.theme));
        body.querySelector('#sizeVal').textContent = settings.fontSize;
        body.querySelector('#zoomVal').textContent = Math.round(settings.zoom * 100) + ' %';
      };
      sync();
      const change = (fn) => { relayout(fn); saveSettings(); sync(); };

      body.querySelectorAll('#modeSeg button').forEach((b) => {
        b.onclick = () => {
          if (b.disabled || b.dataset.mode === reader.mode) return;
          switchMode(b.dataset.mode);
        };
      });
      const box = body.querySelector('#ocrBox');
      if (box) renderOcrBox(box);
      const offer = body.querySelector('#ocrOffer');
      if (offer) offer.onclick = () => {
        const div = document.createElement('div');
        div.innerHTML = ocrBoxHTML(reader.book);
        offer.replaceWith(div.firstElementChild);
        renderOcrBox(body.querySelector('#ocrBox'));
      };
      body.querySelectorAll('[data-step]').forEach((b) => {
        b.onclick = () => change(() => { settings.fontSize = clamp(settings.fontSize + +b.dataset.step, 13, 36); });
      });
      // Zoom de 5 en 5 %; manteniendo pulsado sigue solo.
      body.querySelectorAll('[data-zoom]').forEach((b) => {
        let hold = null;
        const step = () => {
          zoomAround(Math.round((settings.zoom + +b.dataset.zoom * 0.05) * 20) / 20);
          sync();
        };
        const stop = () => { clearTimeout(hold); clearInterval(hold); hold = null; };
        b.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          step();
          hold = setTimeout(() => { hold = setInterval(step, 90); }, 420);
        });
        ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, stop));
      });
      body.querySelectorAll('[data-font]').forEach((b) => {
        b.onclick = () => change(() => { settings.font = b.dataset.font; });
      });
      body.querySelectorAll('.seg[data-key] button').forEach((b) => {
        b.onclick = () => change(() => { settings[b.parentElement.dataset.key] = b.dataset.v; });
      });
      body.querySelectorAll('[data-theme]').forEach((b) => {
        b.onclick = () => change(() => { settings.theme = b.dataset.theme; });
      });
      body.querySelectorAll('[data-flag]').forEach((inp) => {
        inp.onchange = () => {
          const k = inp.dataset.flag;
          if (k === 'justify') change(() => { settings.justify = inp.checked; });
          else { settings[k] = inp.checked; saveSettings(); applyReaderLook(); }
          if (k === 'keepAwake') updateWakeLock();
        };
      });
    },
  });
};

/* ---------------------- Pantalla encendida (Wake Lock) ---------------------- */

async function updateWakeLock() {
  if (!settings.keepAwake || !reader.id || document.visibilityState !== 'visible') {
    releaseWakeLock();
    return;
  }
  if (reader.wake || !('wakeLock' in navigator)) return;
  try {
    reader.wake = await navigator.wakeLock.request('screen');
    reader.wake.addEventListener('release', () => { reader.wake = null; });
  } catch { /* no permitido */ }
}
function releaseWakeLock() {
  if (reader.wake) { reader.wake.release().catch(() => {}); reader.wake = null; }
}

/* --------------------------- Girar el teléfono --------------------------- */

let lastW = window.innerWidth;
window.addEventListener('resize', debounce(() => {
  if (!reader.id || window.innerWidth === lastW) return;
  lastW = window.innerWidth;
  relayout(() => {});
}, 150));

/* -------------------------------- Arranque -------------------------------- */

setThemeColor(getComputedStyle(document.body).getPropertyValue('--bg').trim() || '#f2f2f7');
loadLibrary();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // Unos segundos después de abrir, baja en segundo plano lo que falte para
  // funcionar sin internet (motor de OCR, idiomas, tipografías).
  setTimeout(() => {
    if (!navigator.onLine) return;
    navigator.serviceWorker.ready.then((reg) => reg.active && reg.active.postMessage('warm')).catch(() => {});
  }, 4000);
}
