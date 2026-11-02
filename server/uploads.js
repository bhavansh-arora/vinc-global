'use strict';
// File uploads: random names on disk, size limits, and a check of each file's first bytes
// so a renamed file cannot pretend to be a PDF, a sheet or an image.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { UPLOAD_DIR } = require('./db');

const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 25);

const TYPES = {
  pdf: { exts: ['.pdf'], test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  xlsx: { exts: ['.xlsx', '.xlsm'], test: (b) => b[0] === 0x50 && b[1] === 0x4b },
  csv: { exts: ['.csv'], test: (b) => !b.subarray(0, 512).includes(0) },
  jpg: { exts: ['.jpg', '.jpeg'], test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  png: { exts: ['.png'], test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
};
const MIME = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', jpg: 'image/jpeg', png: 'image/png' };

const GROUPS = {
  pdf: ['pdf'],
  excel: ['xlsx', 'csv'],
  kyc: ['pdf', 'jpg', 'png'],
  certificate: ['pdf', 'jpg', 'png'],
};

function typeForExt(ext) {
  return Object.keys(TYPES).find((t) => TYPES[t].exts.includes(ext));
}

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => cb(null, crypto.randomBytes(18).toString('hex') + path.extname(file.originalname).toLowerCase().slice(0, 8)),
});

/**
 * Express middleware that accepts one file in field "file" and checks it belongs to `group`
 * (or to the group named by req.body[groupField] when group is a function).
 */
function single(groupOf) {
  const upload = multer({ storage, limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 } }).single('file');
  return (req, res, next) => {
    upload(req, res, (err) => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE' ? `Files can be up to ${MAX_MB} MB.` : 'Upload failed: ' + err.message;
        return res.status(400).json({ error: msg });
      }
      if (!req.file) return next();
      const group = typeof groupOf === 'function' ? groupOf(req) : groupOf;
      const allowed = GROUPS[group] || [];
      const ext = path.extname(req.file.originalname).toLowerCase();
      const type = typeForExt(ext);
      const fail = (msg) => { fs.rm(req.file.path, { force: true }, () => {}); res.status(400).json({ error: msg }); };
      if (ext === '.xls') return fail('Old .xls files are not supported. Please save the sheet as .xlsx and upload again.');
      if (!type || !allowed.includes(type)) return fail(`This file type is not allowed here. Allowed: ${allowed.map((t) => TYPES[t].exts.join(', ')).join(', ')}.`);
      const fd = fs.openSync(req.file.path, 'r');
      const head = Buffer.alloc(512);
      fs.readSync(fd, head, 0, 512, 0);
      fs.closeSync(fd);
      if (!TYPES[type].test(head)) return fail('The file contents do not match its extension.');
      req.file.vgType = type;
      req.file.vgMime = MIME[type];
      next();
    });
  };
}

function removeStored(name) {
  if (!name) return;
  const p = path.join(UPLOAD_DIR, path.basename(name));
  fs.rm(p, { force: true }, () => {});
}

function storedPath(name) {
  return path.join(UPLOAD_DIR, path.basename(name));
}

module.exports = { single, removeStored, storedPath, MAX_MB };
