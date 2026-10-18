/* --------------------------------------------------------------------------
   EPUB → el mismo texto por bloques que usa el modo Texto.

   Un EPUB es un ZIP con capítulos en XHTML. Aquí:
     1. se lee el ZIP (sin librerías: DecompressionStream de Safari),
     2. container.xml → el .opf (título, autor, portada, orden de capítulos),
     3. cada capítulo → bloques { t: 'h' | 'p' | 'n', s, p } (p = capítulo),
     4. el índice sale del nav.xhtml (EPUB 3) o del toc.ncx (EPUB 2).
   -------------------------------------------------------------------------- */

import { noteLabel } from './reflow.js';

/* ------------------------------- ZIP ------------------------------- */

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Índice del ZIP: nombre → función que devuelve sus bytes. */
function readZip(buf) {
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not-zip');
  const count = v.getUint16(eocd + 10, true);
  let off = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const files = new Map();
  for (let k = 0; k < count; k++) {
    if (v.getUint32(off, true) !== 0x02014b50) break;
    const method = v.getUint16(off + 10, true);
    const csize = v.getUint32(off + 20, true);
    const nameLen = v.getUint16(off + 28, true);
    const extraLen = v.getUint16(off + 30, true);
    const commentLen = v.getUint16(off + 32, true);
    const local = v.getUint32(off + 42, true);
    const name = dec.decode(u8.subarray(off + 46, off + 46 + nameLen));
    files.set(name, async () => {
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const data = u8.subarray(start, start + csize);
      if (method === 0) return data.slice();
      if (method === 8) return inflateRaw(data);
      throw new Error('zip-method');
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/* ----------------------------- Rutas y XML ----------------------------- */

function resolve(base, href) {
  const clean = decodeURIComponent(href.split('#')[0]);
  if (!clean) return base;
  const parts = base.split('/').slice(0, -1);
  for (const seg of clean.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function parseXml(text, type = 'application/xhtml+xml') {
  let doc = new DOMParser().parseFromString(text, type);
  if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(text, 'text/html');
  return doc;
}

const byTag = (root, tag) => [...root.getElementsByTagNameNS('*', tag)];
const firstText = (root, tag) => { const el = byTag(root, tag)[0]; return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; };

/* ------------------------- Capítulo → bloques ------------------------- */

const HEAD = /^h[1-6]$/;
const BLOCKISH = /^(p|li|blockquote|pre|dt|dd|figcaption|caption|tr|address)$/;
const SKIP = /^(script|style|head|title|svg|math|nav)$/;
const SUPD = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const epubType = (el) => (el.getAttribute && (el.getAttribute('epub:type') || el.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || el.getAttribute('role') || '')) || '';
const isNote = (el) => /footnote|endnote|rearnote|doc-footnote|doc-endnote/.test(epubType(el));

/** Texto de un elemento: <br> = espacio, llamadas de nota = ¹ ² ³. */
function inlineText(el) {
  let out = '';
  for (const n of el.childNodes) {
    if (n.nodeType === 3) out += n.nodeValue;
    else if (n.nodeType === 1) {
      const tag = n.localName.toLowerCase();
      if (SKIP.test(tag) || isNote(n)) continue;
      if (tag === 'br') { out += ' '; continue; }
      const t = inlineText(n);
      if (/noteref|doc-noteref/.test(epubType(n)) || (tag === 'sup' && /^\s*\[?\d{1,3}\]?\s*$/.test(t))) {
        out += t.replace(/[^\d]/g, '').split('').map((d) => SUPD[d]).join('');
      } else out += t;
    }
  }
  return out;
}

function chapterBlocks(doc, p) {
  const blocks = [];
  const notes = [];
  const push = (t, s) => {
    s = s.replace(/\s+/g, ' ').trim();
    if (s) blocks.push({ t, s: t === 'n' ? noteLabel(s) : s, p });
  };
  const walk = (el) => {
    for (const n of el.children) {
      const tag = n.localName.toLowerCase();
      if (SKIP.test(tag)) continue;
      if (isNote(n)) { notes.push(inlineText(n)); continue; }
      if (HEAD.test(tag)) { push('h', inlineText(n)); continue; }
      if (tag === 'tr') {
        push('p', [...n.children].map((c) => inlineText(c).replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · '));
        continue;
      }
      if (BLOCKISH.test(tag)) {
        // Un bloque que contiene otros bloques (p. ej. <li><p>…</p></li>) se recorre por dentro.
        if ([...n.children].some((c) => BLOCKISH.test(c.localName.toLowerCase()) || HEAD.test(c.localName.toLowerCase()))) walk(n);
        else push('p', inlineText(n));
        continue;
      }
      // div, section, etc.: si sólo tienen texto suelto, son un párrafo.
      const hasBlockKids = [...n.children].some((c) => {
        const t = c.localName.toLowerCase();
        return BLOCKISH.test(t) || HEAD.test(t) || /^(div|section|article|aside|ul|ol|table|tbody|thead|figure|header|footer|main|dl)$/.test(t);
      });
      if (hasBlockKids) walk(n);
      else if (!/^(img|image|hr)$/.test(tag)) push('p', inlineText(n));
    }
  };
  const body = byTag(doc, 'body')[0] || doc.documentElement;
  walk(body);
  for (const n of notes) push('n', n);
  return blocks;
}

/* ------------------------------ Índice ------------------------------ */

function readNav(doc, base, spineIndex) {
  const nav = byTag(doc, 'nav').find((n) => /toc/.test(epubType(n))) || byTag(doc, 'nav')[0];
  if (!nav) return [];
  const out = [];
  const walk = (ol, depth) => {
    for (const li of [...ol.children].filter((c) => c.localName.toLowerCase() === 'li')) {
      const a = [...li.children].find((c) => /^(a|span)$/.test(c.localName.toLowerCase()));
      const href = a && a.getAttribute('href');
      const page = href ? spineIndex.get(resolve(base, href)) : undefined;
      if (a && page !== undefined) out.push({ title: a.textContent.replace(/\s+/g, ' ').trim(), page, depth });
      const sub = [...li.children].find((c) => c.localName.toLowerCase() === 'ol');
      if (sub && depth < 3) walk(sub, depth + 1);
    }
  };
  const ol = byTag(nav, 'ol')[0];
  if (ol) walk(ol, 0);
  return out;
}

function readNcx(doc, base, spineIndex) {
  const out = [];
  const walk = (el, depth) => {
    for (const np of [...el.children].filter((c) => c.localName === 'navPoint')) {
      const label = firstText(np, 'text');
      const content = byTag(np, 'content')[0];
      const page = content ? spineIndex.get(resolve(base, content.getAttribute('src') || '')) : undefined;
      if (label && page !== undefined) out.push({ title: label, page, depth });
      if (depth < 3) walk(np, depth + 1);
    }
  };
  const map = byTag(doc, 'navMap')[0];
  if (map) walk(map, 0);
  return out;
}

/* ------------------------------- Todo ------------------------------- */

export function isEpub(name, bytes) {
  if (/\.epub$/i.test(name || '')) return true;
  const u8 = new Uint8Array(bytes.slice ? bytes.slice(0, 60) : bytes);
  return u8[0] === 0x50 && u8[1] === 0x4b && new TextDecoder().decode(u8.subarray(30, 60)).includes('mimetypeapplication/epub');
}

/**
 * Lee un EPUB. Devuelve { title, author, cover (ArrayBuffer|null),
 * blocks, pageStart, chars, toc, numPages (= capítulos) }.
 */
export async function readEpub(buf, onProgress) {
  const zip = readZip(buf);
  const text = async (path) => {
    const get = zip.get(path);
    if (!get) throw new Error('missing ' + path);
    return new TextDecoder().decode(await get());
  };
  const container = parseXml(await text('META-INF/container.xml'), 'application/xml');
  const opfPath = byTag(container, 'rootfile')[0].getAttribute('full-path');
  const opf = parseXml(await text(opfPath), 'application/xml');

  const title = firstText(opf, 'title');
  const author = firstText(opf, 'creator');
  const manifest = new Map();
  for (const it of byTag(opf, 'item')) {
    manifest.set(it.getAttribute('id'), {
      href: resolve(opfPath, it.getAttribute('href')),
      type: it.getAttribute('media-type') || '',
      props: it.getAttribute('properties') || '',
    });
  }
  const spine = byTag(opf, 'itemref')
    .filter((r) => r.getAttribute('linear') !== 'no')
    .map((r) => manifest.get(r.getAttribute('idref')))
    .filter((m) => m && /html/.test(m.type));
  const spineIndex = new Map(spine.map((m, i) => [m.href, i]));

  // Portada: properties="cover-image" (EPUB 3) o <meta name="cover"> (EPUB 2).
  let coverItem = [...manifest.values()].find((m) => /cover-image/.test(m.props));
  if (!coverItem) {
    const meta = byTag(opf, 'meta').find((m) => m.getAttribute('name') === 'cover');
    if (meta) coverItem = manifest.get(meta.getAttribute('content'));
  }
  let cover = null;
  if (coverItem && /image/.test(coverItem.type) && zip.get(coverItem.href)) {
    cover = (await zip.get(coverItem.href)()).buffer;
  }

  const blocks = [];
  for (let i = 0; i < spine.length; i++) {
    try {
      const doc = parseXml(await text(spine[i].href));
      blocks.push(...chapterBlocks(doc, i));
    } catch { /* capítulo dañado: se salta */ }
    if (onProgress) onProgress((i + 1) / spine.length);
  }

  let toc = [];
  try {
    const navItem = [...manifest.values()].find((m) => /\bnav\b/.test(m.props));
    if (navItem) toc = readNav(parseXml(await text(navItem.href)), navItem.href, spineIndex);
    if (!toc.length) {
      const ncxItem = [...manifest.values()].find((m) => /ncx/.test(m.type));
      if (ncxItem) toc = readNcx(parseXml(await text(ncxItem.href), 'application/xml'), ncxItem.href, spineIndex);
    }
  } catch { /* sin índice */ }

  const n = Math.max(1, spine.length);
  const pageStart = new Array(n);
  let bi = blocks.length;
  for (let p = n - 1; p >= 0; p--) {
    while (bi > 0 && blocks[bi - 1].p >= p) bi--;
    pageStart[p] = bi;
  }
  const chars = blocks.reduce((s, b) => s + b.s.length, 0);
  return { title, author, cover, coverType: coverItem ? coverItem.type : '', blocks, pageStart, chars, toc, numPages: n };
}
