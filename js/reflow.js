/* --------------------------------------------------------------------------
   Reflujo: convierte el texto posicionado de un PDF en párrafos.

   Un PDF no tiene párrafos: tiene trozos de texto con coordenadas. Para poder
   cambiar el tamaño de letra hay que reconstruir el texto corrido:

     1. trozos  → líneas    (misma altura en la página)
     2. quitar cabeceras, pies y números de página repetidos
     3. líneas  → párrafos  (sangría, línea corta, salto vertical, tamaño)
     4. unir palabras cortadas con guion al final de línea
     5. unir párrafos que continúan en la página siguiente

   Todo es puro (sin DOM ni pdf.js) para poder probarlo en Node.
   -------------------------------------------------------------------------- */

const TERMINAL = /[.!?:;…»”"'’)\]]$/;
// Puntos guía de un índice: «Capítulo uno . . . . . . 12».
const LEADER = /(?:\.\s?){5,}|(?:…\s?){3,}|(?:·\s?){5,}|_{5,}/;
const LOWER_START = /^[a-záéíóúüñàèìòùç]/;

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function percentile(xs, p) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
}

/** Trozos de pdf.js (`getTextContent().items`) → trozos simples. */
export function simplifyItems(items) {
  const out = [];
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const t = it.transform;
    // Texto girado (marcas de agua, lomos) no es texto de lectura.
    if (Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01) continue;
    const h = Math.abs(t[3]) || it.height || 0;
    out.push({ s: it.str, x: t[4], y: t[5], w: it.width || 0, h, eol: !!it.hasEOL });
  }
  return out;
}

/** Trozos → líneas, respetando el orden del flujo del PDF (sirve para columnas). */
export function itemsToLines(items) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    const blank = it.s.trim() === '';
    if (blank && !cur) continue;
    if (!blank) {
      const tol = Math.max(1, 0.5 * Math.min(it.h || 1, cur ? cur.h || 1 : it.h || 1));
      if (!cur || Math.abs(it.y - cur.y) > tol) {
        if (cur) lines.push(cur);
        cur = { parts: [], y: it.y, h: it.h };
      }
      cur.parts.push(it);
      cur.h = Math.max(cur.h, it.h);
    } else if (cur) {
      cur.parts.push({ ...it, blank: true });
    }
  }
  if (cur) lines.push(cur);

  return lines
    .map((l) => {
      const parts = l.parts.filter((p) => !p.blank).sort((a, b) => a.x - b.x);
      let text = '';
      let prevEnd = null;
      for (const p of parts) {
        if (prevEnd !== null) {
          const gap = p.x - prevEnd;
          const needsSpace =
            gap > 0.12 * (p.h || l.h) && !/\s$/.test(text) && !/^\s/.test(p.s);
          if (needsSpace) text += ' ';
        }
        text += p.s;
        prevEnd = p.x + p.w;
      }
      text = text.replace(/\s+/g, ' ').trim();
      const x = parts.length ? parts[0].x : 0;
      const xEnd = parts.reduce((m, p) => Math.max(m, p.x + p.w), x);
      return { text, x, xEnd, y: l.y, h: l.h };
    })
    .filter((l) => l.text.length > 0);
}

const ROMAN = /^[ivxlcdm]+$/i;
function isPageNumber(text) {
  const t = text.replace(/[\s\-–—.·|]/g, '');
  return /^\d{1,4}$/.test(t) || (t.length <= 6 && ROMAN.test(t)) ||
    /^(p[áa]g(ina)?|page)\d{1,4}$/i.test(t);
}

function normalizeEdge(text) {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/** Quita números de página y cabeceras/pies que se repiten. Muta `pages`. */
export function stripRunningHeads(pages, donePages = pages.length) {
  const counts = new Map();
  const EDGE = 2;
  for (const lines of pages) {
    const seen = new Set();
    const edge = [...lines.slice(0, EDGE), ...lines.slice(-EDGE)];
    for (const l of edge) {
      const k = normalizeEdge(l.text);
      if (k.length > 80 || seen.has(k)) continue;
      seen.add(k);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  const minRepeat = Math.max(3, Math.ceil(donePages * 0.12));
  const isRunning = (l) => {
    const k = normalizeEdge(l.text);
    return isPageNumber(l.text) || (k.length <= 80 && (counts.get(k) || 0) >= minRepeat);
  };
  return pages.map((lines) => {
    let a = 0;
    let b = lines.length;
    for (let i = 0; i < EDGE && a < b && isRunning(lines[a]); i++) a++;
    for (let i = 0; i < EDGE && b > a && isRunning(lines[b - 1]); i++) b--;
    return lines.slice(a, b);
  });
}

function joinLines(a, b) {
  if (/[-­]$/.test(a) && LOWER_START.test(b)) return a.slice(0, -1) + b;
  return a + ' ' + b;
}

/**
 * Detecta dos columnas. Marca cada línea con su columna (`c`) y, si el PDF
 * las trae entremezcladas (renglón izquierdo, renglón derecho…), las ordena:
 * primero toda la columna izquierda, luego la derecha.
 */
function orderColumns(lines, body) {
  const one = () => lines.map((l) => ({ ...l, c: 0 }));
  if (lines.length < 8) return one();
  const L = Math.min(...lines.map((l) => l.x));
  const R = Math.max(...lines.map((l) => l.xEnd));
  const W = R - L;
  if (W <= body * 10) return one();
  const mid = L + W / 2;
  const narrow = lines.filter((l) => l.xEnd - l.x < W * 0.62).length;
  const rightStarts = lines.filter((l) => l.x > mid - body * 0.5).length;
  const leftEnds = lines.filter((l) => l.xEnd < mid + body * 0.5).length;
  if (narrow < lines.length * 0.6 || rightStarts < 4 || leftEnds < 4) return one();
  const out = lines.map((l) => ({ ...l, c: l.x >= mid - body * 0.5 ? 1 : 0 }));
  let switches = 0;
  for (let k = 1; k < out.length; k++) if (out[k].c !== out[k - 1].c) switches++;
  if (switches > 3) {
    const idx = new Map(out.map((l, k) => [l, k]));
    out.sort((a, b) => a.c - b.c || b.y - a.y || idx.get(a) - idx.get(b));
  }
  return out;
}

/** Líneas de una página → bloques { t: 'p' | 'h' | 'n', s } ('n' = nota al pie). */
export function linesToBlocks(linesIn, bodySize) {
  if (!linesIn.length) return [];
  const body = bodySize || median(linesIn.map((l) => l.h)) || 10;
  const lines = orderColumns(linesIn, body);
  const isBody = (l) => Math.abs(l.h - body) <= body * 0.15;

  // Medidas de cada columna por separado (si no, en dos columnas todo
  // parecería «línea corta» y cada renglón sería un párrafo).
  const ncol = Math.max(...lines.map((l) => l.c)) + 1;
  const geo = [];
  for (let c = 0; c < ncol; c++) {
    const inCol = lines.filter((l) => l.c === c);
    const bodyLines = inCol.filter(isBody);
    const ref = bodyLines.length >= 3 ? bodyLines : inCol.length ? inCol : lines;
    const left = percentile(ref.map((l) => l.x), 0.15);
    const right = percentile(ref.map((l) => l.xEnd), 0.85);
    geo.push({ left, right, width: Math.max(1, right - left) });
  }

  const gaps = [];
  for (let k = 1; k < lines.length; k++) {
    const g = lines[k - 1].y - lines[k].y;
    if (g > 0 && lines[k].c === lines[k - 1].c && isBody(lines[k])) gaps.push(g);
  }
  const lineGap = median(gaps) || body * 1.2;

  // Notas al pie: letra más pequeña, por debajo de todo el texto normal.
  // (Por columna: en dos columnas cada una tiene sus notas abajo.)
  const lowestBody = [];
  for (let c = 0; c < ncol; c++) {
    const ys = lines.filter((l) => l.c === c && l.h >= body * 0.93).map((l) => l.y);
    lowestBody.push(ys.length ? Math.min(...ys) : -Infinity);
  }
  const isNote = (l) => l.h < body * 0.88 && l.y < lowestBody[l.c] - body * 0.3 && l.text.length >= 8;

  const blocks = [];
  let cur = null;
  const flush = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // Llamadas de nota sueltas (¹ ² en su propia línea): no son texto de lectura.
    if (l.text.length <= 3 && l.h < body * 0.85 && /^[\d*†‡a-z,]+$/i.test(l.text)) continue;
    if (LEADER.test(l.text)) {
      flush();
      const s = l.text.replace(new RegExp(LEADER.source, 'g'), ' · ').replace(/\s+·\s+/g, ' · ')
        .replace(/^ · | · $/g, '').trim();
      if (s && !/^[\d\s·]+$/.test(s)) blocks.push({ t: 'p', s });
      else if (s && blocks.length) blocks[blocks.length - 1].s += ' · ' + s.replace(/^[·\s]+/, '');
      continue;
    }
    const note = isNote(l);
    const big = !note && l.h > body * 1.2 && l.text.length < 140;
    const kind = note ? 'n' : big ? 'h' : 'p';
    if (!cur) {
      cur = { t: kind, s: l.text, h: l.h };
      continue;
    }
    if (note || cur.t === 'n') {
      // Cada nota empieza con su número o asterisco; si no, sigue la anterior.
      if (note && cur.t === 'n' && !/^[\d*†‡¹²³⁴⁵⁶⁷⁸⁹⁰]/.test(l.text)) cur.s = joinLines(cur.s, l.text);
      else { flush(); cur = { t: kind, s: l.text, h: l.h }; }
      continue;
    }
    const prev = lines[i - 1];
    const g = geo[l.c];
    const gp = geo[prev.c];
    const gap = prev.y - l.y;
    const colChange = l.c !== prev.c;
    const sizeChange = Math.abs(l.h - prev.h) > Math.max(prev.h, l.h) * 0.18;
    const columnJump = colChange || gap < -lineGap * 0.5;
    const bigGap = !colChange && (gap > lineGap * 1.45 || gap < -lineGap * 0.5);
    const prevEnds = TERMINAL.test(prev.text);
    const indented = l.x > g.left + body * 0.8 && l.x < g.left + g.width * 0.3 &&
      (colChange || Math.abs(prev.x - gp.left) < body * 0.8);
    const prevShort = prev.xEnd < gp.right - body * 2.5;
    const centered = Math.abs((l.x + l.xEnd) / 2 - (g.left + g.right) / 2) < body &&
      l.x > g.left + body * 2;

    let brk =
      sizeChange ||
      (bigGap && !(columnJump && !prevEnds)) ||
      (columnJump && prevEnds && (indented || prevShort)) ||
      (indented && prevEnds) ||
      (indented && prevShort) ||
      (prevShort && prevEnds) ||
      (prevShort && prev.xEnd - prev.x < gp.width * 0.55 && !/[-\u00AD]$/.test(prev.text)) ||
      (cur.t === 'h' && !big);
    // Un título de dos líneas sigue siendo un solo título.
    if (cur.t === 'h' && big && !sizeChange && gap > 0 && gap < Math.max(prev.h, l.h) * 1.7) brk = false;
    if (centered && prevShort && !brk && cur.t === 'p' && prev.xEnd - prev.x < g.width * 0.7) brk = true;

    if (brk) {
      flush();
      cur = { t: kind, s: l.text, h: l.h };
    } else {
      cur.s = joinLines(cur.s, l.text);
    }
  }
  flush();
  return blocks.map((b) => ({ t: b.t, s: b.t === 'n' ? noteLabel(b.s) : b.s }));
}

const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
/** «1Nota…» → «¹ Nota…» */
export function noteLabel(s) {
  return s.replace(/^(\d{1,3})\s*(?=\S)/, (m, d) => [...d].map((c) => SUP[c]).join('') + ' ');
}

/**
 * Páginas de trozos simplificados → { blocks, pageStart, chars }.
 * `blocks[i].p` es la página (0-based) donde empieza el bloque.
 * `pageStart[p]` es el índice del primer bloque que empieza en p o después.
 */
export function buildReflow(pagesItems, structPages = []) {
  const r = buildReflowFromLines(pagesItems.map(itemsToLines), structPages);
  cleanDialogueGlyphs(r.blocks);
  return r;
}

/* Algunas fuentes dibujan la raya de diálogo con dos piezas y una de ellas
   viene mal etiquetada: «—QSí —», «—pPues…». En español nunca va una letra
   suelta pegada entre la raya y una mayúscula, así que se quita esa letra.
   Sólo se toca si en el libro el patrón se repite (si es un caso suelto,
   como «—iPhone», se respeta).                                              */
const DASH_GLYPH = /([—–―])(\s?)([A-Za-zÑñ])(?=[A-ZÁÉÍÓÚÑ][a-záéíóúñü]|[¿¡«"“])/g;

export function cleanDialogueGlyphs(blocks) {
  const counts = new Map();
  for (const b of blocks) {
    if (!b.s) continue;
    for (const m of b.s.matchAll(DASH_GLYPH)) counts.set(m[3], (counts.get(m[3]) || 0) + 1);
  }
  const stray = new Set([...counts].filter(([, n]) => n >= 2).map(([ch]) => ch));
  if (!stray.size) return 0;
  let fixed = 0;
  for (const b of blocks) {
    if (!b.s) continue;
    b.s = b.s.replace(DASH_GLYPH, (all, dash, sp, ch) => {
      if (!stray.has(ch)) return all;
      fixed++;
      return dash + sp;
    });
  }
  return fixed;
}

/**
 * Igual que `buildReflow`, pero desde líneas ya armadas (las del OCR).
 * Una página `null` está pendiente: las seguidas se juntan en un solo bloque
 * `{ t: 'x', p, n }` («páginas p … p+n-1 aún sin reconocer»).
 */
export function buildReflowFromLines(linePagesRaw, structPages = []) {
  const done = linePagesRaw.map((l) => l !== null && l !== undefined);
  const linePages = stripRunningHeads(linePagesRaw.map((l) => l || []), done.filter(Boolean).length);
  const allH = [];
  for (const lines of linePages) for (const l of lines) {
    for (let k = 0; k < Math.min(8, Math.ceil(l.text.length / 20)); k++) allH.push(l.h);
  }
  const body = median(allH);

  const blocks = [];
  let chars = 0;
  linePages.forEach((lines, p) => {
    if (!done[p]) {
      const last = blocks[blocks.length - 1];
      if (last && last.t === 'x' && last.p + last.n === p) last.n++;
      else blocks.push({ t: 'x', s: '', p, n: 1 });
      return;
    }
    // Página etiquetada: la estructura del PDF manda; si no, se adivina.
    const pageBlocks = structPages[p] || linesToBlocks(lines, body);
    pageBlocks.forEach((b, i) => {
      chars += b.s.length;
      // Párrafo partido entre dos páginas: se sigue en el mismo bloque
      // (aunque entre medias haya notas al pie de la página anterior).
      let k = blocks.length - 1;
      while (k >= 0 && blocks[k].t === 'n') k--;
      const last = blocks[k];
      if (i === 0 && last && last.t === 'p' && b.t === 'p' &&
          !TERMINAL.test(last.s) && LOWER_START.test(b.s)) {
        last.s = joinLines(last.s, b.s);
        return;
      }
      blocks.push({ t: b.t, s: b.s, p });
    });
  });

  const pageStart = new Array(linePages.length);
  let bi = blocks.length;
  for (let p = linePages.length - 1; p >= 0; p--) {
    while (bi > 0 && blocks[bi - 1].p >= p) bi--;
    pageStart[p] = bi;
  }
  return { blocks, pageStart, chars };
}

/* ------------------------ Texto basura (mal codificado) ------------------------

   Cuando la fuente de un PDF no trae bien la tabla de traducción, el texto
   sale como letras sin sentido («Mb nbñbob fo rvf…») o símbolos raros. Se
   detecta porque casi no aparecen palabras comunes y la proporción de vocales
   es anormal. Esas páginas se leen mejor con OCR.                            */

const COMMON = new Set(('de la que el en y a los se del las un por con no una su para es al lo como más ' +
  'pero sus le ya o fue este ha sí porque esta son entre cuando muy sin sobre también me hasta hay donde ' +
  'the of and to in is that it for was on with as his he be at by i this had not are but from or have ' +
  'le les des et est un une du dans qui pas der die und das ist nicht zu den mit').split(' '));
const ES_WORDS = new Set('que de la el los las por con una para del se no es como'.split(' '));
const EN_WORDS = new Set('the and of to is that with for was it this are'.split(' '));

/** { garbled, tokens, es, en } para el texto plano de una página. */
export function pageQuality(text) {
  const chars = text.replace(/\s/g, '');
  if (!chars.length) return { garbled: false, tokens: 0, es: 0, en: 0 };
  const weird = (text.match(/[-�\u0000-\u0008\u000E-\u001F]/g) || []).length;
  const tokens = text.toLowerCase().match(/[\p{L}]+/gu) || [];
  let common = 0;
  let es = 0;
  let en = 0;
  for (const t of tokens) {
    if (COMMON.has(t)) common++;
    if (ES_WORDS.has(t)) es++;
    if (EN_WORDS.has(t)) en++;
  }
  const letters = (text.match(/\p{L}/gu) || []).length;
  const vowels = (text.match(/[aeiouáéíóúàèìòùäëïöüAEIOUÁÉÍÓÚ]/g) || []).length;
  const vowelRatio = letters ? vowels / letters : 0;
  const symbols = chars.length - letters - (text.match(/[\d.,;:¿?¡!«»"'()\-—–]/g) || []).length;
  let garbled = weird / chars.length > 0.05;
  if (!garbled && tokens.length >= 40) {
    const commonRatio = common / tokens.length;
    garbled = commonRatio < 0.04 && (vowelRatio < 0.25 || vowelRatio > 0.68 || symbols / chars.length > 0.2);
  }
  return { garbled, tokens: tokens.length, es, en };
}

/**
 * Sustituye en `base` (texto del PDF) las páginas reconocidas por OCR.
 * `ocrPages[p]` son las líneas del OCR de la página p, o null si no se tocó.
 */
export function spliceOcrPages(base, ocrPages) {
  const n = base.pageStart.length;
  const byPage = new Map();
  for (const b of base.blocks) {
    if (!byPage.has(b.p)) byPage.set(b.p, []);
    byPage.get(b.p).push(b);
  }
  const blocks = [];
  let chars = 0;
  for (let p = 0; p < n; p++) {
    const src = ocrPages[p] ? linesToBlocks(trimOcrEdges(ocrPages[p])).map((b) => ({ ...b, p })) : byPage.get(p) || [];
    for (const b of src) { blocks.push({ ...b }); chars += (b.s || '').length; }
  }
  const pageStart = new Array(n);
  let bi = blocks.length;
  for (let p = n - 1; p >= 0; p--) {
    while (bi > 0 && blocks[bi - 1].p >= p) bi--;
    pageStart[p] = bi;
  }
  return { blocks, pageStart, chars };
}

/** Quita de una página reconocida su encabezado y su número de página. */
function trimOcrEdges(lines) {
  if (lines.length < 3) return lines;
  const body = median(lines.map((l) => l.h));
  // Encabezados y pies suelen ir en letra más pequeña y ser cortos.
  const isEdge = (l) => isPageNumber(l.text) || (l.h < body * 0.85 && l.text.length < 90);
  let a = 0;
  let b = lines.length;
  for (let i = 0; i < 2 && a < b && isEdge(lines[a]); i++) a++;
  for (let i = 0; i < 2 && b > a && isEdge(lines[b - 1]); i++) b--;
  return lines.slice(a, b);
}
