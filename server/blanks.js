'use strict';
// Finds the blanks (runs of 3+ underscores) in a PDF, with the nearby text as a hint of what each is for.
// Used through a worker thread (blanks-worker.js), never directly by the web server.
const { PDFDocument, StandardFonts } = require('pdf-lib');

// pdf.js tries to load a native graphics library (@napi-rs/canvas, built on Skia) to draw pages. We only read
// text, and that native library can crash the whole process on some server CPUs, so it is never loaded here:
// it is left out of the Docker image, blocked below, and the one class pdf.js needs from it is supplied in
// plain JavaScript.
const Module = require('node:module');
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@napi-rs/canvas' || request.startsWith('@napi-rs/canvas-')) throw new Error('Native canvas is disabled in VINC Global.');
  return realLoad.call(this, request, ...rest);
};
if (!globalThis.DOMMatrix) {
  /** A 2D affine matrix with the parts of the DOMMatrix interface pdf.js may touch when not drawing. */
  class DOMMatrix {
    constructor(init) {
      const m = Array.isArray(init) || ArrayBuffer.isView(init) ? [...init] : [1, 0, 0, 1, 0, 0];
      [this.a, this.b, this.c, this.d, this.e, this.f] = m.length >= 6 ? m : [1, 0, 0, 1, 0, 0];
    }
    get is2D() { return true; }
    get isIdentity() { return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0; }
    multiplySelf(o) {
      const { a, b, c, d, e, f } = this;
      this.a = a * o.a + c * o.b; this.b = b * o.a + d * o.b;
      this.c = a * o.c + c * o.d; this.d = b * o.c + d * o.d;
      this.e = a * o.e + c * o.f + e; this.f = b * o.e + d * o.f + f;
      return this;
    }
    preMultiplySelf(o) { const m = new DOMMatrix([o.a, o.b, o.c, o.d, o.e, o.f]).multiplySelf(this); Object.assign(this, { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f }); return this; }
    multiply(o) { return new DOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]).multiplySelf(o); }
    translateSelf(x = 0, y = 0) { return this.multiplySelf({ a: 1, b: 0, c: 0, d: 1, e: x, f: y }); }
    translate(x, y) { return this.multiply({ a: 1, b: 0, c: 0, d: 1, e: x || 0, f: y || 0 }); }
    scaleSelf(sx = 1, sy = sx) { return this.multiplySelf({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 }); }
    scale(sx = 1, sy = sx) { return this.multiply({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 }); }
    invertSelf() {
      const { a, b, c, d, e, f } = this; const det = a * d - b * c;
      if (!det) { [this.a, this.b, this.c, this.d, this.e, this.f] = [NaN, NaN, NaN, NaN, NaN, NaN]; return this; }
      [this.a, this.b, this.c, this.d, this.e, this.f] = [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
      return this;
    }
    inverse() { return new DOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]).invertSelf(); }
    transformPoint(p = {}) { const x = p.x || 0, y = p.y || 0; return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: 0, w: 1 }; }
  }
  globalThis.DOMMatrix = DOMMatrix;
}

// pdf.js prints a warning for each graphics feature it cannot set up; none is needed to read text. (This file
// only runs inside the detection worker thread, so the filter stays on.)
for (const level of ['log', 'warn']) {
  const out = console[level];
  console[level] = (...a) => { if (typeof a[0] === 'string' && /^Warning: Cannot (load|polyfill)/.test(a[0])) return; out(...a); };
}
let pdfjsP = null;
const loadPdfjs = () => (pdfjsP = pdfjsP || import('pdfjs-dist/legacy/build/pdf.mjs'));

const pdfSafe = (s) => String(s == null ? '' : s).replace(/₹/g, 'Rs.').replace(/[^\x20-\x7E\u00A0-\u00FF‘’“”–—…]/g, '?');

async function detectBlanks(buf) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;   // verbosity 0: no warnings
  const out = [];
  // Where a blank sits inside a longer run of text, place it using real letter widths (Helvetica metrics),
  // which is far closer than counting characters.
  const metrics = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
  const widthOf = (t) => { try { return metrics.widthOfTextAtSize(pdfSafe(t), 10); } catch { return t.length * 5; } };
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const H = page.getViewport({ scale: 1 }).height;
    const items = (await page.getTextContent()).items.filter((i) => i.str && i.str.trim());
    const notBlank = (s) => s.replace(/_+/g, '').trim();
    for (const it of items) {
      const re = /_{3,}/g; let m;
      while ((m = re.exec(it.str))) {
        const base = it.transform[5];
        const full = widthOf(it.str) || 1;
        const x = it.transform[4] + it.width * (widthOf(it.str.slice(0, m.index)) / full), w = it.width * (widthOf(m[0]) / full);
        // Hint: words just before it on the same line, else the label just above it in the same column.
        let hint = notBlank(it.str.slice(0, m.index));
        if (!hint) {
          const left = items.filter((o) => o !== it && Math.abs(o.transform[5] - base) < 2 && o.transform[4] + o.width <= x + 1 && x - (o.transform[4] + o.width) < 40 && notBlank(o.str))
            .sort((a, b) => b.transform[4] - a.transform[4]);
          if (left[0]) hint = notBlank(left[0].str);
        }
        if (!hint) {
          const above = items.filter((o) => o.transform[5] > base + 2 && o.transform[5] - base < 24 && o.transform[4] >= x - 6 && o.transform[4] < x + w && notBlank(o.str))
            .sort((a, b) => a.transform[5] - b.transform[5] || a.transform[4] - b.transform[4]);
          if (above[0]) hint = notBlank(above[0].str);
        }
        out.push({ id: out.length + 1, page: n, x: +x.toFixed(1), w: +Math.max(12, w).toFixed(1), line: +(H - base + 3).toFixed(1), hint: hint.slice(-48) });
      }
    }
  }
  return { pages: doc.numPages, blanks: out };
}

module.exports = { detectBlanks };
