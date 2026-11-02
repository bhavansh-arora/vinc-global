'use strict';
// Serving stored files. Everything is view-only: shown inline in the in-page viewer, never cached,
// and only to the people allowed to see it. Share certificates are the one thing members may download.
const fs = require('node:fs');
const express = require('express');
const ExcelJS = require('exceljs');
const { db } = require('./db');
const A = require('./auth');
const up = require('./uploads');

const r = express.Router();
r.use(A.requireAuth);

const isAdmin = (req) => req.user.role === 'admin';
const isActiveMember = (req) => req.user.role !== 'admin' && A.accessState(req.user) === 'active';

function sendStored(res, row, { download = false } = {}) {
  const p = up.storedPath(row.stored_name);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File missing on the server.' });
  const safe = (row.original_name || 'file').replace(/[^\w.\- ]+/g, '_');
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${safe}"`);
  fs.createReadStream(p).pipe(res);
}

function canSeeDocument(req, d) {
  if (isAdmin(req)) return true;
  if (!isActiveMember(req)) return false;
  return d.audience_user_id == null || d.audience_user_id === req.user.id;
}

r.get('/doc/:id/raw', (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!d || d.kind !== 'pdf' || !canSeeDocument(req, d)) return res.status(404).json({ error: 'Not found.' });
  if (!isAdmin(req)) A.logAccess(req.user.id, 'viewed_document', d.title);
  sendStored(res, d);
});

// Excel number formats, simplified: percentages, fixed decimals and thousands separators.
function formatNumber(v, fmt) {
  if (typeof v !== 'number' || !isFinite(v)) return null;
  const f = String(fmt || '').split(';')[0];
  if (!f || /general/i.test(f) || /[dmyhs]/i.test(f.replace(/"[^"]*"/g, ''))) return null; // general or date: let ExcelJS decide
  const dec = (f.match(/\.(0+)/) || [, ''])[1].length;
  if (f.includes('%')) return (v * 100).toFixed(dec) + '%';
  const grouped = f.includes(',');
  const s = grouped ? v.toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec }) : v.toFixed(dec);
  const prefix = (f.match(/^[^#0]*?([₹$€£])/) || [, ''])[1];
  return prefix + s;
}

// Sheets are read on the server and sent as plain cell text, so the workbook itself never leaves the server.
r.get('/doc/:id/sheet', async (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!d || d.kind !== 'excel' || !canSeeDocument(req, d)) return res.status(404).json({ error: 'Not found.' });
  try {
    const wb = new ExcelJS.Workbook();
    const p = up.storedPath(d.stored_name);
    if (/\.csv$/i.test(d.original_name || '')) await wb.csv.readFile(p); else await wb.xlsx.readFile(p);
    const MAX_ROWS = 3000, MAX_COLS = 80;
    const sheets = [];
    wb.eachSheet((ws) => {
      if (ws.state && ws.state !== 'visible') return;
      const rows = [];
      let cols = 0;
      const rowCount = Math.min(ws.actualRowCount ? ws.rowCount : 0, MAX_ROWS);
      for (let i = 1; i <= rowCount; i++) {
        const row = ws.getRow(i);
        const cells = [];
        const n = Math.min(row.cellCount, MAX_COLS);
        for (let c = 1; c <= n; c++) {
          const cell = row.getCell(c);
          const num = typeof cell.value === 'number' ? cell.value : (cell.type === ExcelJS.ValueType.Formula && typeof cell.result === 'number' ? cell.result : null);
          let t = num != null ? formatNumber(num, cell.numFmt) : null;
          if (t == null && num != null) t = String(Number(num.toPrecision(12)));
          if (t == null) { try { t = cell.text; } catch { t = cell.value == null ? '' : String(cell.value); } }
          cells.push({ t: t == null ? '' : String(t), b: !!(cell.font && cell.font.bold), n: num != null });
        }
        while (cells.length && cells[cells.length - 1].t === '') cells.pop();
        cols = Math.max(cols, cells.length);
        rows.push(cells);
      }
      while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
      sheets.push({ name: ws.name, cols, rows, truncated: ws.rowCount > MAX_ROWS });
    });
    if (!isAdmin(req)) A.logAccess(req.user.id, 'viewed_document', d.title);
    res.setHeader('Cache-Control', 'no-store, private');
    res.json({ title: d.title, sheets });
  } catch (e) {
    res.status(422).json({ error: 'This sheet could not be read. Try saving it again as .xlsx.' });
  }
});

r.get('/kyc/:id/raw', (req, res) => {
  const d = db.prepare('SELECT * FROM kyc_docs WHERE id = ?').get(req.params.id);
  if (!d || (!isAdmin(req) && d.user_id !== req.user.id)) return res.status(404).json({ error: 'Not found.' });
  sendStored(res, d);
});

r.get('/cert/:id/raw', (req, res) => {
  const d = db.prepare('SELECT * FROM certificates WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found.' });
  if (!isAdmin(req) && !(isActiveMember(req) && d.user_id === req.user.id)) return res.status(404).json({ error: 'Not found.' });
  if (!isAdmin(req)) A.logAccess(req.user.id, 'downloaded_certificate', d.title);
  sendStored(res, d, { download: req.query.download === '1' });
});

module.exports = r;
