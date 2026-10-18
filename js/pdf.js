/* --------------------------------------------------------------------------
   Todo lo que toca pdf.js: abrir, portada, metadatos, índice y texto.
   -------------------------------------------------------------------------- */

import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import { simplifyItems, buildReflow, pageQuality } from './reflow.js';

const BASE = new URL('../vendor/pdfjs/', import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.mjs';

/** `data` se transfiere al worker: queda inutilizable. Pasa una copia si la necesitas. */
export function openPdf(data) {
  return pdfjs.getDocument({
    data,
    cMapUrl: BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: BASE + 'standard_fonts/',
    wasmUrl: BASE + 'wasm/',
    isEvalSupported: false,
  }).promise;
}

function cleanTitle(t) {
  if (!t) return '';
  return String(t)
    .replace(/^Microsoft (Word|PowerPoint) - /i, '')
    .replace(/\.(docx?|pdf|pptx?|odt|rtf|txt)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleFromFilename(name) {
  return name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Sin título';
}

export async function readMeta(doc, filename) {
  let info = {};
  try { info = (await doc.getMetadata()).info || {}; } catch { /* sin metadatos */ }
  let title = cleanTitle(info.Title);
  if (title.length < 3 || /^(untitled|sin t[ií]tulo|documento\d*|document\d*)$/i.test(title)) {
    title = titleFromFilename(filename);
  }
  const author = cleanTitle(info.Author);
  return { title, author: author.length > 1 && author.length < 80 ? author : '' };
}

/** Primera página como imagen (portada de la biblioteca). */
export async function renderCover(doc, width = 360) {
  const page = await doc.getPage(1);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / vp1.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
  canvas.width = canvas.height = 0;
  page.cleanup();
  return { blob, ratio: vp1.height / vp1.width };
}

/** Recorre todas las páginas: tamaños + texto reconstruido. */
export async function extractText(doc, onProgress) {
  const n = doc.numPages;
  const pages = [];
  const structPages = [];
  const sizes = [];
  const garbled = [];
  let es = 0;
  let en = 0;
  let tagged = false;
  try {
    const mark = doc.getMarkInfo ? await doc.getMarkInfo() : null;
    tagged = !!(mark && (mark.Marked || (mark.get && mark.get('Marked'))));
  } catch { /* sin información */ }
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    sizes.push([Math.round(vp.width), Math.round(vp.height)]);
    try {
      const tc = await page.getTextContent({ includeMarkedContent: tagged });
      pages.push(simplifyItems(tc.items));
      const q = pageQuality(tc.items.map((it) => (typeof it.str === 'string' ? it.str + (it.hasEOL ? '\n' : ' ') : '')).join(''));
      if (q.garbled) garbled.push(i - 1);
      es += q.es;
      en += q.en;
      structPages.push(tagged ? await structBlocks(page, tc.items) : null);
    } catch {
      pages.push([]);
      structPages.push(null);
    }
    page.cleanup();
    if (onProgress && (i % 4 === 0 || i === n)) onProgress(i / n);
  }
  const r = buildReflow(pages, structPages);
  return { ...r, sizes, numPages: n, tagged: structPages.some(Boolean), garbled, lang: en > es ? 'eng' : 'spa' };
}

/* ---------------------- PDF etiquetado (estructura) ----------------------

   Muchos PDF hechos con Word, InDesign o Typst traen marcado qué es título,
   qué es párrafo y en qué orden se lee; los encabezados y números de página
   vienen como «Artifact» (decoración). Si la página lo trae, se usa tal cual
   en vez de adivinar por posiciones.                                        */

const HEADING = /^(H[1-6]?|Title)$/;
const BLOCK = /^(P|H[1-6]?|Title|LI|BlockQuote|Quote|Caption|TOCI|Note|Code|Formula)$/;
const SKIP = /^(Figure|Artifact)$/;
const NOTE = /^(Note|FENote|Footnote|Endnote)$/;
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
const superscript = (t) => t.replace(/\s+/g, '').replace(/\d/g, (d) => SUP[d]);
const ROW = /^TR$/;
const CELL = /^(TH|TD)$/;

async function structBlocks(page, items) {
  let tree;
  try { tree = await page.getStructTree(); } catch { return null; }
  if (!tree || !tree.children || !tree.children.length) return null;

  // Texto de cada contenido marcado (mcid), y cuánto texto hay fuera de decoración.
  const byId = new Map();
  const stack = [];
  let pageChars = 0;
  for (const it of items) {
    if (it.type === 'beginMarkedContentProps' || it.type === 'beginMarkedContent') {
      stack.push(it.tag === 'Artifact' ? '#artifact' : it.id || stack[stack.length - 1] || null);
      continue;
    }
    if (it.type === 'endMarkedContent') { stack.pop(); continue; }
    if (typeof it.str !== 'string') continue;
    const id = stack[stack.length - 1];
    if (id === '#artifact') continue;
    pageChars += it.str.trim().length;
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(it.str + (it.hasEOL ? '\n' : ''));
  }
  if (!pageChars) return null;

  // Las notas al pie salen del párrafo (`notes`) y su llamada queda como ¹ ² ³.
  const textOf = (node, notes) => {
    if (!node) return '';
    if (node.type === 'content') return (byId.get(node.id) || []).join('');
    const role = node.role || '';
    if (SKIP.test(role)) return '';
    if (NOTE.test(role) && notes) { notes.push(textOf(node, null)); return ''; }
    const kids = node.children || [];
    return kids.map((c, i) => {
      const t = textOf(c, notes);
      const nextIsNote = kids[i + 1] && NOTE.test(kids[i + 1].role || '');
      return c.role === 'Lbl' && nextIsNote && notes && /^\s*\d+\s*$/.test(t) ? superscript(t) : t;
    }).join('');
  };
  const blocks = [];
  let used = 0;
  const push = (t, raw) => {
    let s = joinRaw(raw);
    if (t === 'n') s = s.replace(/^(\d+)\s*/, (m, d) => superscript(d) + ' ');
    if (!s) return;
    used += s.replace(/\s/g, '').length;
    blocks.push({ t, s });
  };
  const walk = (node) => {
    if (!node) return;
    if (node.type === 'content') { push('p', textOf(node)); return; }
    const role = node.role || '';
    if (SKIP.test(role)) return;
    if (NOTE.test(role)) { push('n', textOf(node)); return; }
    if (BLOCK.test(role)) {
      const notes = [];
      push(HEADING.test(role) ? 'h' : 'p', textOf(node, notes));
      for (const n of notes) push('n', n);
      return;
    }
    if (ROW.test(role)) {
      push('p', (node.children || []).filter((c) => CELL.test(c.role || '')).map((c) => joinRaw(textOf(c))).filter(Boolean).join(' · '));
      return;
    }
    (node.children || []).forEach(walk);
  };
  walk(tree);

  // Sólo se confía en la estructura si cubre casi todo el texto de la página.
  return blocks.length && used >= pageChars * 0.8 ? blocks : null;
}

/** Texto crudo con saltos de línea → un párrafo, uniendo palabras con guion. */
function joinRaw(raw) {
  return raw
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .reduce((acc, line) => {
      if (!acc) return line;
      if (/[-\u00AD]$/.test(acc) && /^[a-záéíóúüñ]/.test(line)) return acc.slice(0, -1) + line;
      return acc + ' ' + line;
    }, '');
}

/** Índice del PDF aplanado: [{ title, page (0-based), depth }]. */
export async function readOutline(doc) {
  let outline;
  try { outline = await doc.getOutline(); } catch { return []; }
  if (!outline) return [];
  const out = [];
  async function walk(items, depth) {
    for (const it of items) {
      let page = null;
      try {
        let dest = it.dest;
        if (typeof dest === 'string') dest = await doc.getDestination(dest);
        if (Array.isArray(dest) && dest[0]) {
          page = typeof dest[0] === 'number' ? dest[0] : await doc.getPageIndex(dest[0]);
        }
      } catch { /* destino roto */ }
      if (it.title && page !== null) out.push({ title: it.title.trim(), page, depth });
      if (it.items && it.items.length && depth < 3) await walk(it.items, depth + 1);
    }
  }
  await walk(outline, 0);
  return out;
}
