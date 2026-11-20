'use strict';
// Finds the blanks (runs of 3+ underscores) in a PDF, with the nearby text as a hint of what each is for.
// Used through a worker thread (blanks-worker.js), never directly by the web server.
const { PDFDocument, StandardFonts } = require('pdf-lib');

const pdfSafe = (s) => String(s == null ? '' : s).replace(/₹/g, 'Rs.').replace(/[^\x20-\x7E\u00A0-\u00FF‘’“”–—…]/g, '?');

async function detectBlanks(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
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
