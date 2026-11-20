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

// What counts as a blank written in text: underscores, or a row of dots ("......", "……", ". . . . .").
const BLANK_RUN = /_{3,}|[.…]{5,}|…{2,}|(?:\. ){4,}\./g;
const isBlankChar = (c) => c === '_' || c === '.' || c === '…';
const MAX_BLANKS = 400;

/**
 * Find the blanks in a PDF, in three ways:
 *  1. text: underscores or dotted leaders, read across whole lines (so pieces drawn separately join up);
 *  2. drawn lines: short horizontal lines with no words on them (Word's underlined spaces, bordered gaps),
 *     leaving out table borders, page-wide rules and underlined words;
 *  3. fillable form fields (text and signature fields).
 * Positions are PDF points from the top-left of the page; `line` is the bottom of the blank.
 */
async function detectBlanks(buf) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;   // verbosity 0: no warnings
  // Where a blank sits inside a longer run of text, place it using real letter widths (Helvetica metrics),
  // which is far closer than counting characters.
  const metrics = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
  const widthOf = (t) => { try { return metrics.widthOfTextAtSize(pdfSafe(t), 10); } catch { return t.length * 5; } };
  const found = [];
  for (let n = 1; n <= doc.numPages && found.length < MAX_BLANKS; n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const H = vp.height, W = vp.width;
    const items = (await page.getTextContent()).items.filter((i) => i.str && i.str.trim() && i.transform);
    const lines = buildLines(items);
    const onPage = [];
    // 1. Blanks written as text
    for (const L of lines) {
      const { str, at } = joinLine(L.items);
      BLANK_RUN.lastIndex = 0;
      let m;
      while ((m = BLANK_RUN.exec(str))) {
        const first = at[m.index] || at[m.index + 1], last = at[m.index + m[0].length - 1] || at[m.index + m[0].length - 2];
        if (!first || !last) continue;
        const x = xOf(first, widthOf), x2 = xOf(last, widthOf, true);
        if (x2 - x < 8) continue;
        let hint = str.slice(0, m.index).split('\u0000').pop();
        hint = hint.replace(/[_.…]{3,}/g, '\u0001').split('\u0001').pop().replace(/\s+/g, ' ').trim();
        if (!hint) {
          const after = str.slice(m.index + m[0].length).split('\u0000')[0].trim();
          if (/^\(.{2,40}\)/.test(after)) hint = after.match(/^\((.{2,40}?)\)/)[1];
        }
        if (!hint) hint = labelAbove(items, x, x2, first.it.transform[5]);
        onPage.push({ page: n, x, w: Math.max(12, x2 - x), line: H - first.it.transform[5] + 3, hint, source: 'text' });
      }
    }
    // 2. Drawn lines
    try {
      for (const ln of await drawnLines(page, pdfjs, W)) {
        const underText = items.some((o) => {
          if (!o.str.trim()) return false;
          const ox = o.transform[4], ow = o.width, base = o.transform[5];
          const overlap = Math.min(ln.x1, ox + ow) - Math.max(ln.x0, ox);
          return base >= ln.y - 1 && base <= ln.y + 6 && overlap > 0.4 * Math.min(ln.x1 - ln.x0, ow);
        });
        if (underText) continue;                                   // an underlined word, not a blank
        const hint = labelLeft(items, ln.x0, ln.y) || labelAbove(items, ln.x0, ln.x1, ln.y + 2);
        onPage.push({ page: n, x: ln.x0, w: ln.x1 - ln.x0, line: H - ln.y + 0.5, hint, source: 'line' });
      }
    } catch { /* drawn lines are a bonus; text blanks still count */ }
    // 3. Fillable form fields
    try {
      for (const a of await page.getAnnotations()) {
        if (a.subtype !== 'Widget' || !['Tx', 'Sig'].includes(a.fieldType) || !Array.isArray(a.rect)) continue;
        const [x0, y0, x1] = a.rect;
        if (x1 - x0 < 12) continue;
        const name = a.fieldType === 'Sig' ? 'Signature' : String(a.alternativeText || a.fieldName || '').replace(/[._]+/g, ' ').replace(/\[\d+\]/g, '').trim();
        onPage.push({ page: n, x: x0, w: x1 - x0, line: H - y0 - 2, hint: labelLeft(items, x0, y0 + 3) || name, source: 'field' });
      }
    } catch { /* ignore */ }
    // The same blank found twice (a drawn line under underscores, a field over a line) is kept once.
    const kept = [];
    for (const b of onPage) {
      const dup = kept.some((k) => Math.abs(k.line - b.line) < 6 && Math.min(k.x + k.w, b.x + b.w) - Math.max(k.x, b.x) > 0.5 * Math.min(k.w, b.w));
      if (!dup) kept.push(b);
    }
    kept.sort((a, b) => a.line - b.line || a.x - b.x);
    found.push(...kept);
  }
  const blanks = found.slice(0, MAX_BLANKS).map((b, i) => ({
    id: i + 1, page: b.page, x: +b.x.toFixed(1), w: +b.w.toFixed(1), line: +b.line.toFixed(1),
    hint: String(b.hint || '').replace(/\s+/g, ' ').trim().slice(-48), source: b.source,
  }));
  return { pages: doc.numPages, blanks, truncated: found.length > MAX_BLANKS };
}

/** Text items grouped into lines (same baseline), left to right. */
function buildLines(items) {
  const lines = [];
  for (const it of [...items].sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4])) {
    const y = it.transform[5];
    let L = lines.find((l) => Math.abs(l.y - y) < 2.2);
    if (!L) { L = { y, items: [] }; lines.push(L); }
    L.items.push(it);
  }
  for (const L of lines) L.items.sort((a, b) => a.transform[4] - b.transform[4]);
  return lines;
}

/** One line as a string, with each character mapped back to its text item. Wide gaps become column breaks. */
function joinLine(lineItems) {
  let str = '';
  const at = [];
  let prev = null;
  for (const it of lineItems) {
    if (prev) {
      const gap = it.transform[4] - (prev.transform[4] + prev.width);
      const joinsBlank = isBlankChar(prev.str.slice(-1)) && isBlankChar(it.str.charAt(0)) && gap < 8;
      if (gap > 30 && !joinsBlank) { str += '\u0000'; at.push(null); }
      else if (gap > 1 && !joinsBlank) { str += ' '; at.push(null); }
    }
    for (let k = 0; k < it.str.length; k++) { str += it.str[k]; at.push({ it, k }); }
    prev = it;
  }
  return { str, at };
}

/** Where a character starts (or ends) on the page. */
function xOf({ it, k }, widthOf, end = false) {
  const full = widthOf(it.str) || 1;
  return it.transform[4] + it.width * (widthOf(it.str.slice(0, end ? k + 1 : k)) / full);
}

/** Words just before a blank on the same line. */
function labelLeft(items, x, base) {
  const left = items.filter((o) => Math.abs(o.transform[5] - base) < 7 && o.transform[4] + o.width <= x + 2 && x - (o.transform[4] + o.width) < 60 && o.str.replace(/[_.…]+/g, '').trim())
    .sort((a, b) => b.transform[4] - a.transform[4]);
  return left[0] ? left[0].str.replace(/[_.…]{3,}/g, ' ').trim() : '';
}

/** A label printed just above a blank, in the same column. */
function labelAbove(items, x, x2, base) {
  const above = items.filter((o) => o.transform[5] > base + 2 && o.transform[5] - base < 24 && o.transform[4] >= x - 6 && o.transform[4] < x2 && o.str.replace(/[_.…]+/g, '').trim())
    .sort((a, b) => a.transform[5] - b.transform[5] || a.transform[4] - b.transform[4]);
  return above[0] ? above[0].str.replace(/[_.…]{3,}/g, ' ').trim() : '';
}

/**
 * Short horizontal lines drawn on the page (PDF coordinates, y up). Table and box borders (a vertical line
 * meets an end), page-wide rules and very short dashes are left out.
 */
async function drawnLines(page, pdfjs, pageWidth) {
  const O = pdfjs.OPS;
  const paints = new Set([O.stroke, O.closeStroke, O.fill, O.eoFill, O.fillStroke, O.eoFillStroke, O.closeFillStroke, O.closeEOFillStroke]);
  const strokes = new Set([O.stroke, O.closeStroke, O.fillStroke, O.eoFillStroke, O.closeFillStroke, O.closeEOFillStroke]);
  const ops = await page.getOperatorList();
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  let ctm = [1, 0, 0, 1, 0, 0], lw = 1;
  const stack = [];
  const hs = [], vs = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    if (fn === O.save) stack.push([ctm, lw]);
    else if (fn === O.restore) { if (stack.length) [ctm, lw] = stack.pop(); }
    else if (fn === O.transform && args && args.length === 6) ctm = mul(ctm, args);
    else if (fn === O.setLineWidth && args) lw = Number(args[0]) || 0;
    else if (fn === O.constructPath && Array.isArray(args) && typeof args[0] === 'number' && args[2] && args[2].length === 4) {
      if (!paints.has(args[0])) continue;
      const [a, b, c, d] = args[2];
      const pad = strokes.has(args[0]) ? Math.max(lw, 0.5) / 2 : 0;
      const pts = [apply(ctm, a, b), apply(ctm, c, b), apply(ctm, a, d), apply(ctm, c, d)];
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
      const scale = Math.hypot(ctm[0], ctm[1]) || 1;
      box.y0 -= pad * scale; box.y1 += pad * scale;
      const w = box.x1 - box.x0, h = box.y1 - box.y0;
      if (h <= 2.5 && w >= 0.3) hs.push(box);
      else if (w <= 2.5 && h >= 4) vs.push(box);
    }
  }
  // Join pieces of one line (dotted lines, borders drawn in parts).
  hs.sort((p, q) => (p.y0 + p.y1) / 2 - (q.y0 + q.y1) / 2 || p.x0 - q.x0);
  const merged = [];
  for (const h of hs) {
    const cy = (h.y0 + h.y1) / 2;
    const m = merged.find((g) => Math.abs(g.y - cy) < 1.2 && h.x0 <= g.x1 + 4 && h.x1 >= g.x0 - 4);
    if (m) { m.x0 = Math.min(m.x0, h.x0); m.x1 = Math.max(m.x1, h.x1); }
    else merged.push({ x0: h.x0, x1: h.x1, y: cy });
  }
  const touches = (g) => vs.some((v) => (Math.abs(v.x0 - g.x0) < 3 || Math.abs(v.x1 - g.x1) < 3 || Math.abs(v.x0 - g.x1) < 3 || Math.abs(v.x1 - g.x0) < 3) && g.y >= v.y0 - 3 && g.y <= v.y1 + 3);
  return merged.filter((g) => {
    const w = g.x1 - g.x0;
    if (w < 24 || w > 0.75 * pageWidth) return false;     // too short to write in, or a rule across the page
    if (touches(g)) return false;                           // part of a table or a box
    // Two lines of the same length close together are usually a box drawn without sides.
    return !merged.some((o) => o !== g && Math.abs(o.x0 - g.x0) < 2 && Math.abs(o.x1 - g.x1) < 2 && Math.abs(o.y - g.y) < 14);
  });
}

module.exports = { detectBlanks };
