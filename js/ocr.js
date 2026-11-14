/* --------------------------------------------------------------------------
   OCR: convierte páginas escaneadas (imágenes) en texto, dentro del teléfono.

   Usa Tesseract compilado a WebAssembly (vendor/tesseract). Cada página se
   dibuja con pdf.js a buena resolución, Tesseract devuelve las líneas con su
   posición, y esas líneas pasan por el mismo reflujo que un PDF con texto.
   Nada sale del teléfono.
   -------------------------------------------------------------------------- */

const BASE = new URL('../vendor/tesseract/', import.meta.url).href;

export const OCR_LANGS = {
  spa: 'Español',
  eng: 'English',
};

let libP = null;
function loadLib() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (libP) return libP;
  libP = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = BASE + 'tesseract.min.js';
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => { libP = null; reject(new Error('No se pudo cargar el OCR')); };
    document.head.appendChild(s);
  });
  return libP;
}

let worker = null;
let workerLang = null;

async function getWorker(lang) {
  if (worker && workerLang === lang) return worker;
  if (worker) { await worker.terminate().catch(() => {}); worker = null; }
  const T = await loadLib();
  worker = await T.createWorker(lang, T.OEM ? T.OEM.LSTM_ONLY : 1, {
    workerPath: BASE + 'worker.min.js',
    corePath: BASE + 'core',
    langPath: BASE + 'lang',
    workerBlobURL: false,
    gzip: true,
  });
  workerLang = lang;
  return worker;
}

export async function stopOcr() {
  if (worker) { const w = worker; worker = null; workerLang = null; await w.terminate().catch(() => {}); }
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Reconoce una página (0-based) → líneas { text, x, xEnd, y, h } con y hacia arriba. */
export async function ocrPage(doc, index, lang) {
  const w = await getWorker(lang);
  const page = await doc.getPage(index + 1);
  const vp1 = page.getViewport({ scale: 1 });
  // ~1700 px de ancho: lo que Tesseract necesita para letra de libro.
  let scale = 1700 / vp1.width;
  const maxPx = 5_000_000;
  if (vp1.width * vp1.height * scale * scale > maxPx) scale = Math.sqrt(maxPx / (vp1.width * vp1.height));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
  page.cleanup();

  let data;
  try {
    ({ data } = await w.recognize(canvas, {}, { blocks: true, text: false }));
  } finally {
    canvas.width = canvas.height = 0;
  }

  const lines = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const text = (line.text || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        // Ruido de ilustraciones: confianza muy baja o sin letras.
        if (line.confidence < 35 || !/[\p{L}\p{N}]/u.test(text)) continue;
        const b = line.bbox;
        // Altura de la línea: la de las palabras (sin contar descendentes)
        // es más estable que la caja, que cambia si hay «g», «p», «Á»…
        const wordsH = (line.words || []).map((wd) => wd.bbox.y1 - wd.bbox.y0);
        const rowH = line.rowAttributes && (line.rowAttributes.rowHeight || line.rowAttributes.row_height);
        const h = rowH || median(wordsH) || (b.y1 - b.y0);
        lines.push({ text, x: b.x0, xEnd: b.x1, y: -b.y1, h });
      }
    }
  }
  return lines;
}
