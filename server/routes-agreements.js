'use strict';
// Onboarding agreements: member signing and admin management. See server/agreements.js.
const fs = require('node:fs');
const express = require('express');
const { PDFDocument } = require('pdf-lib');
const { db, getSettings, tx } = require('./db');
const A = require('./auth');
const AG = require('./agreements');
const notify = require('./notify');
const up = require('./uploads');

const member = express.Router();
const admin = express.Router();
member.use(A.requireMember);
admin.use(A.requireAdmin);

const str = (v, max = 200) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const userRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const agRow = (id) => db.prepare('SELECT * FROM agreements WHERE id = ?').get(id);
const memberLabel = (u) => `${u.name || u.uid} (${u.uid})`;

function sendPdf(res, file, filename, download) {
  const p = AG.filePath(file);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File missing on the server.' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename.replace(/[^\w.\- ]+/g, '_')}"`);
  fs.createReadStream(p).pipe(res);
}

function readGeo(g) {
  if (!g || typeof g !== 'object') return null;
  const lat = Number(g.lat), lon = Number(g.lon), acc = Number(g.acc);
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return null;
  return { lat, lon, acc: acc > 0 ? Math.min(acc, 100000) : null };
}

/** After execution: when all of the member's agreements are executed they become permanent. */
function upgradeIfComplete(userId) {
  if (!AG.allExecuted(userId)) return false;
  const u = userRow(userId);
  if (!u || u.role === 'admin') return false;
  if (u.status === 'active' && u.access_type === 'permanent') return false;
  const now = Date.now();
  db.prepare("UPDATE users SET status = 'active', access_type = 'permanent', access_expires_at = NULL, approved_at = ?, renewal_requested = 0 WHERE id = ?").run(now, userId);
  A.logAccess(userId, 'approved_permanent', 'agreements signed');
  notify.approved(userRow(userId));
  return true;
}

async function executeAndNotify(ag, opts) {
  const done = await AG.execute(ag, opts);
  const u = userRow(done.user_id);
  A.logAccess(u.id, 'agreement_executed', AG.KINDS[done.kind].title);
  notify.agreementExecuted(u, done, AG.KINDS[done.kind].title, AG.filePath(done.executed_name));
  const upgraded = upgradeIfComplete(u.id);
  return { done, upgraded };
}

// ================================================================== member
function memberList(u) {
  // The agreement for the member's role is prepared automatically once the admin has uploaded the template.
  AG.ensureFor(u);
  const rows = db.prepare("SELECT * FROM agreements WHERE user_id = ? AND status != 'void' ORDER BY id").all(u.id);
  const voided = db.prepare("SELECT kind, void_reason FROM agreements WHERE user_id = ? AND status = 'void' ORDER BY id DESC").all(u.id);
  return {
    agreements: rows.map((r) => ({ ...AG.publicAgreement(r), last_void_reason: (voided.find((v) => v.kind === r.kind) || {}).void_reason || null })),
    waiting_for_template: !AG.activeTemplate(AG.kindForRole(u.role)) && !rows.length,
    all_executed: AG.allExecuted(u.id),
  };
}

member.get('/', (req, res) => res.json(memberList(req.user)));

member.get('/:id', (req, res) => {
  const ag = agRow(req.params.id);
  if (!ag || ag.user_id !== req.user.id || ag.status === 'void') return res.status(404).json({ error: 'Not found.' });
  const u = req.user;
  const prev = db.prepare("SELECT fields FROM agreements WHERE user_id = ? AND fields IS NOT NULL ORDER BY id DESC LIMIT 1").get(u.id);
  const prefill = prev ? JSON.parse(prev.fields) : { name: u.name || '', email: u.email || '', phone: u.phone || '' };
  if (ag.status === 'pending') {
    const last = db.prepare("SELECT at FROM agreement_events WHERE agreement_id = ? AND action = 'Opened the document' ORDER BY at DESC LIMIT 1").get(ag.id);
    if (!last || last.at < Date.now() - 30 * 60000) AG.logEvent(ag.id, u.name || u.uid, 'Opened the document', null, req.ip);
  }
  const spec = AG.KINDS[ag.kind];
  res.json({
    agreement: AG.publicAgreement(ag),
    spec: { title: spec.title, pages: spec.pages, fields: spec.fields },
    prefill, tickets: AG.TICKETS, consent: AG.CONSENT,
    company: { signer: `${AG.companySettings().signer_name}, ${AG.companySettings().signer_title}` },
  });
});

// The document itself, shown in the signing view. Before execution: the blank template; after: the executed copy.
member.get('/:id/document', (req, res) => {
  const ag = agRow(req.params.id);
  if (!ag || ag.user_id !== req.user.id || ag.status === 'void') return res.status(404).json({ error: 'Not found.' });
  if (ag.status === 'executed') return sendPdf(res, ag.executed_name, `${ag.ref} ${AG.KINDS[ag.kind].title}.pdf`, req.query.download === '1');
  const tpl = db.prepare('SELECT * FROM agreement_templates WHERE id = ?').get(ag.template_id);
  if (!tpl) return res.status(404).json({ error: 'Template missing.' });
  sendPdf(res, tpl.stored_name, `${AG.KINDS[ag.kind].title}.pdf`, false);
});

member.post('/:id/sign', async (req, res) => {
  const ag = agRow(req.params.id);
  if (!ag || ag.user_id !== req.user.id || ag.status === 'void') return res.status(404).json({ error: 'Not found.' });
  if (ag.status !== 'pending') return res.status(409).json({ error: 'This agreement has already been signed.' });
  const { fields, errors } = AG.validateFields(ag.kind, req.body.fields || {});
  const place = str(req.body.place, 60);
  if (place.length < 2) errors.push('Enter the place where you are signing, for example Bengaluru.');
  else if (!AG.SAFE.test(place)) errors.push('Please write the place in English letters.');
  if (req.body.consent !== true) errors.push('Please tick the box to agree to sign electronically.');
  const sig = AG.decodeSignature(req.body.signature);
  if (!sig) errors.push('Please add your signature.');
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  const geo = readGeo(req.body.geo);
  const sigFile = AG.saveFile(sig, '.png');
  const now = Date.now();
  const actor = fields.name;
  db.prepare(`UPDATE agreements SET fields = ?, member_sig = ?, member_signed_at = ?, member_place = ?, member_geo = ?, member_ip = ?, member_ua = ?, status = 'member_signed', updated_at = ? WHERE id = ? AND status = 'pending'`)
    .run(JSON.stringify(fields), sigFile, now, place, geo ? JSON.stringify(geo) : null, req.ip, str(req.get('user-agent') || '', 300), now, ag.id);
  AG.logEvent(ag.id, actor, 'Filled in the details and signed', `place: ${place}${geo ? `, location shared` : ''}`, req.ip);
  A.logAccess(req.user.id, 'agreement_signed', AG.KINDS[ag.kind].title);
  // Keep the member's profile in step with what they signed.
  db.prepare('UPDATE users SET name = ?, phone = COALESCE(NULLIF(phone, \'\'), ?) WHERE id = ?').run(fields.name, fields.phone, req.user.id);

  const cs = AG.companySettings();
  let result = { executed: false, upgraded: false };
  try {
    if (cs.auto && cs.signature) {
      const { done, upgraded } = await executeAndNotify(agRow(ag.id), { method: 'auto', place: cs.place, sigFile: cs.signature, ip: null, actor: 'VINC Global' });
      result = { executed: done.status === 'executed', upgraded };
    } else {
      const signed = agRow(ag.id);
      notify.agreementSignedAdmin(userRow(req.user.id), { ...signed, signedAt: AG.istDateTime(now) }, AG.KINDS[ag.kind].title);
    }
  } catch (e) {
    console.error('[agreements] execution failed', e);
  }
  res.json({ ...result, user: A.publicUser(userRow(req.user.id)), ...memberList(userRow(req.user.id)) });
});

// ================================================================== admin
function templateInfo(kind) {
  const t = AG.activeTemplate(kind);
  if (!t) return { kind, title: AG.KINDS[kind].title, uploaded: false };
  return { kind, title: AG.KINDS[kind].title, uploaded: true, id: t.id, original_name: t.original_name, pages: t.pages, uploaded_at: t.uploaded_at,
    sha256: t.sha256, matches_layout: t.sha256 === AG.KINDS[kind].sha256 };
}

admin.get('/', (_req, res) => {
  const cs = AG.companySettings();
  const members = db.prepare("SELECT * FROM users WHERE role != 'admin' AND status != 'invited' ORDER BY name COLLATE NOCASE").all();
  const rows = [];
  for (const u of members) {
    const ags = db.prepare("SELECT * FROM agreements WHERE user_id = ? AND status != 'void' ORDER BY id").all(u.id);
    const needed = AG.kindForRole(u.role);
    for (const a of ags) rows.push({ user: A.publicUser(u), ...AG.publicAgreement(a, { admin: true }) });
    if (!ags.some((a) => a.kind === needed)) rows.push({ user: A.publicUser(u), kind: needed, title: AG.KINDS[needed].title, status: 'not_sent' });
  }
  const order = { member_signed: 0, pending: 1, not_sent: 2, executed: 3 };
  rows.sort((a, b) => (order[a.status] - order[b.status]) || String(a.user.name || '').localeCompare(String(b.user.name || '')));
  res.json({
    templates: [templateInfo('advisory'), templateInfo('term_sheet')],
    company: { signer_name: cs.signer_name, signer_title: cs.signer_title, place: cs.place, auto: cs.auto, has_signature: !!cs.signature, signature_set_at: cs.signature_set_at },
    rows,
  });
});

admin.post('/templates/:kind', up.single('pdf'), async (req, res) => {
  const kind = req.params.kind;
  const cleanup = () => req.file && up.removeStored(req.file.filename);
  if (!AG.KINDS[kind]) { cleanup(); return res.status(404).json({ error: 'Unknown document.' }); }
  if (!req.file) return res.status(400).json({ error: 'Choose the PDF to upload.' });
  const buf = fs.readFileSync(up.storedPath(req.file.filename));
  let pages = 0;
  try { pages = (await PDFDocument.load(buf)).getPageCount(); } catch { cleanup(); return res.status(400).json({ error: 'This PDF could not be read.' }); }
  if (pages !== AG.KINDS[kind].pages) {
    cleanup();
    return res.status(400).json({ error: `The ${AG.KINDS[kind].title} should have ${AG.KINDS[kind].pages} pages; this file has ${pages}. The blanks are placed for the ${AG.KINDS[kind].pages}-page version.` });
  }
  tx(() => {
    db.prepare('UPDATE agreement_templates SET active = 0 WHERE kind = ?').run(kind);
    db.prepare('INSERT INTO agreement_templates (kind, stored_name, original_name, sha256, pages, active, uploaded_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .run(kind, req.file.filename, req.file.originalname.slice(0, 200), AG.sha256(buf), pages, Date.now());
  });
  res.json(templateInfo(kind));
});

admin.get('/templates/:kind/raw', (req, res) => {
  const t = AG.activeTemplate(req.params.kind);
  if (!t) return res.status(404).json({ error: 'Not uploaded yet.' });
  sendPdf(res, t.stored_name, t.original_name || 'template.pdf', false);
});

admin.put('/company', (req, res) => {
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const b = req.body || {};
  if (b.signature !== undefined) {
    const sig = AG.decodeSignature(b.signature);
    if (!sig) return res.status(400).json({ error: 'Please draw or type the signature again.' });
    set.run('company_sig_file', AG.saveFile(sig, '.png'));
    set.run('company_sig_set_at', String(Date.now()));
  }
  if (b.signer_name !== undefined) { const v = str(b.signer_name, 80); if (v && AG.SAFE.test(v)) set.run('company_signer_name', v); }
  if (b.signer_title !== undefined) { const v = str(b.signer_title, 80); if (v && AG.SAFE.test(v)) set.run('company_signer_title', v); }
  if (b.place !== undefined) { const v = str(b.place, 60); if (v && AG.SAFE.test(v)) set.run('company_sign_place', v); }
  if (b.auto !== undefined) {
    if (b.auto && !AG.companySettings().signature) return res.status(400).json({ error: 'Save the company signature first, then turn on automatic countersigning.' });
    set.run('auto_countersign', b.auto ? '1' : '0');
  }
  const cs = AG.companySettings();
  res.json({ signer_name: cs.signer_name, signer_title: cs.signer_title, place: cs.place, auto: cs.auto, has_signature: !!cs.signature, signature_set_at: cs.signature_set_at });
});

admin.get('/company/signature', (_req, res) => {
  const cs = AG.companySettings();
  if (!cs.signature) return res.status(404).json({ error: 'No saved signature.' });
  res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(AG.filePath(cs.signature)).pipe(res);
});

admin.post('/send', (req, res) => {
  const u = userRow(Number(req.body.user_id));
  if (!u || u.role === 'admin') return res.status(404).json({ error: 'Member not found.' });
  const kind = AG.KINDS[req.body.kind] ? req.body.kind : AG.kindForRole(u.role);
  if (!AG.activeTemplate(kind)) return res.status(400).json({ error: `Upload the ${AG.KINDS[kind].title} first.` });
  const { agreement, created } = AG.ensureFor(u, kind, 'Admin');
  if (!created && agreement.status !== 'pending') return res.status(409).json({ error: 'This member already has this agreement in progress.' });
  AG.logEvent(agreement.id, 'Admin', created ? 'Sent for signature' : 'Reminder sent', null, req.ip);
  const emailed = notify.agreementReady(u, AG.KINDS[kind].title);
  res.json({ ...AG.publicAgreement(agreement, { admin: true }), emailed });
});

admin.get('/:id', (req, res) => {
  const ag = agRow(req.params.id);
  if (!ag) return res.status(404).json({ error: 'Not found.' });
  res.json({
    agreement: AG.publicAgreement(ag, { admin: true }),
    user: A.publicUser(userRow(ag.user_id)),
    events: db.prepare('SELECT at, actor, action, detail, ip FROM agreement_events WHERE agreement_id = ? ORDER BY at, id').all(ag.id),
    company: (({ signer_name, signer_title, place, auto }) => ({ signer_name, signer_title, place, auto, has_signature: !!AG.companySettings().signature }))(AG.companySettings()),
  });
});

admin.get('/:id/member-signature', (req, res) => {
  const ag = agRow(req.params.id);
  if (!ag || !ag.member_sig) return res.status(404).json({ error: 'Not signed yet.' });
  res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(AG.filePath(ag.member_sig)).pipe(res);
});

// Preview of what the member filled in and signed (before the company signs), or the executed copy.
admin.get('/:id/pdf', async (req, res) => {
  const ag = agRow(req.params.id);
  if (!ag) return res.status(404).json({ error: 'Not found.' });
  if (ag.status === 'executed') return sendPdf(res, ag.executed_name, `${ag.ref} ${AG.KINDS[ag.kind].title}.pdf`, req.query.download === '1');
  try {
    const bytes = await AG.buildPdf(ag, { withCompany: false, certificate: false });
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Content-Disposition', 'inline; filename="preview.pdf"');
    res.end(bytes);
  } catch (e) { res.status(500).json({ error: 'Could not build the preview.' }); }
});

admin.post('/:id/countersign', async (req, res) => {
  const ag = agRow(req.params.id);
  if (!ag) return res.status(404).json({ error: 'Not found.' });
  if (ag.status !== 'member_signed') return res.status(409).json({ error: ag.status === 'executed' ? 'Already executed.' : 'The member has not signed yet.' });
  const cs = AG.companySettings();
  const place = str(req.body.place, 60) || cs.place;
  if (!AG.SAFE.test(place)) return res.status(400).json({ error: 'Please write the place in English letters.' });
  let sigFile = cs.signature;
  if (req.body.signature) {
    const sig = AG.decodeSignature(req.body.signature);
    if (!sig) return res.status(400).json({ error: 'Please draw or type the signature again.' });
    sigFile = AG.saveFile(sig, '.png');
    if (req.body.save_signature) {
      const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      set.run('company_sig_file', sigFile); set.run('company_sig_set_at', String(Date.now()));
    }
  }
  if (!sigFile) return res.status(400).json({ error: 'Add the company signature.' });
  try {
    const { done, upgraded } = await executeAndNotify(ag, { method: 'manual', place, sigFile, ip: req.ip, actor: 'Admin (admin)' });
    res.json({ agreement: AG.publicAgreement(done, { admin: true }), upgraded, user: A.publicUser(userRow(done.user_id)) });
  } catch (e) {
    console.error('[agreements] countersign failed', e);
    res.status(500).json({ error: 'Could not build the signed PDF. Please try again.' });
  }
});

admin.post('/:id/void', (req, res) => {
  const ag = agRow(req.params.id);
  if (!ag || ag.status === 'void') return res.status(404).json({ error: 'Not found.' });
  const reason = str(req.body.reason, 300) || null;
  db.prepare("UPDATE agreements SET status = 'void', void_reason = ?, updated_at = ? WHERE id = ?").run(reason, Date.now(), ag.id);
  AG.logEvent(ag.id, 'Admin', 'Voided', reason, req.ip);
  const u = userRow(ag.user_id);
  // A fresh copy is prepared straight away so the member can sign again.
  AG.ensureFor(u, ag.kind, 'Admin');
  notify.agreementVoided(u, AG.KINDS[ag.kind].title, reason);
  res.json({ ok: true });
});

module.exports = { member, admin, upgradeIfComplete };
