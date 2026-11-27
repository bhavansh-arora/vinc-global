'use strict';
// View-only accounts (for example the Company Secretary): every document the admin published in the data room,
// and every agreement anyone has signed. Nothing can be changed, downloaded or sent from here; each view is
// recorded in the access log.
const fs = require('node:fs');
const express = require('express');
const { db } = require('./db');
const A = require('./auth');
const AG = require('./agreements');

const r = express.Router();
r.use(A.requireViewer);

r.get('/documents', (_req, res) => {
  res.json(db.prepare(`SELECT d.id, d.title, d.description, d.category, d.kind, d.original_name, d.size, d.url, d.created_at, d.link_frameable, d.link_reason,
                              u.name AS audience_name, u.uid AS audience_uid
                       FROM documents d LEFT JOIN users u ON u.id = d.audience_user_id ORDER BY d.created_at DESC`).all());
});

// Signed means signed by the member (waiting for VINC) or by both parties (executed).
r.get('/agreements', (_req, res) => {
  const rows = db.prepare(`SELECT a.*, u.name AS member_name, u.uid AS member_uid, u.role AS member_role, u.investor_type AS member_type
                           FROM agreements a JOIN users u ON u.id = a.user_id
                           WHERE a.status IN ('member_signed','executed') ORDER BY COALESCE(a.company_signed_at, a.member_signed_at) DESC`).all();
  res.json(rows.map((a) => ({
    id: a.id, ref: a.joint_ref || a.ref, title: AG.titleOf(a), status: a.status, kind: a.kind, joint: AG.jointInfo(a),
    member: { name: a.member_name, uid: a.member_uid, label: A.memberLabel({ role: a.member_role, investor_type: a.member_type }) },
    member_signed_at: a.member_signed_at, member_place: a.member_place,
    company_signed_at: a.company_signed_at, company_place: a.company_place, company_signer: a.company_signer,
  })));
});

r.get('/agreements/:id/pdf', async (req, res) => {
  const a = db.prepare('SELECT * FROM agreements WHERE id = ?').get(req.params.id);
  if (!a || !['member_signed', 'executed'].includes(a.status)) return res.status(404).json({ error: 'Not found.' });
  A.logAccess(req.user.id, 'viewed_agreement', `${AG.titleOf(a)} ${a.ref}`);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Content-Disposition', 'inline; filename="agreement.pdf"');
  if (a.status === 'executed') {
    const p = AG.filePath(a.executed_name);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'File missing on the server.' });
    return fs.createReadStream(p).pipe(res);
  }
  try { res.end(await AG.buildPdf(a, { withCompany: false, certificate: false })); }
  catch { res.status(500).json({ error: 'Could not open this agreement.' }); }
});

module.exports = r;
