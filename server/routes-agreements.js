'use strict';
// Agreements: member signing and admin management. See server/agreements.js.
const fs = require('node:fs');
const express = require('express');
const { PDFDocument } = require('pdf-lib');
const { db, tx } = require('./db');
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
const fileTitle = (ag) => `${ag.ref} ${AG.titleOf(ag)}.pdf`;

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

/** When everything the member must sign is executed, they become permanent. */
function upgradeIfComplete(userId) {
  if (!AG.requiredDone(userId)) return false;
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
  A.logAccess(u.id, 'agreement_executed', AG.titleOf(done));
  notify.agreementExecuted(u, done, AG.titleOf(done), AG.filePath(done.executed_name));
  return { done, upgraded: upgradeIfComplete(u.id) };
}

// ================================================================== member
function memberList(u) {
  AG.ensureRole(u);
  const rows = db.prepare("SELECT * FROM agreements WHERE user_id = ? AND status != 'void' ORDER BY mandatory DESC, id").all(u.id);
  const voided = db.prepare("SELECT kind, template_id, void_reason FROM agreements WHERE user_id = ? AND status = 'void' ORDER BY id DESC").all(u.id);
  return {
    agreements: rows.map((r) => ({ ...AG.publicAgreement(r), last_void_reason: (voided.find((v) => v.template_id === r.template_id) || {}).void_reason || null })),
    waiting_for_template: !rows.length && !AG.kindsForRole(u.role).some((k) => AG.activeTemplate(k)),
    all_executed: AG.requiredDone(u.id),
  };
}

member.get('/', (req, res) => res.json(memberList(req.user)));

member.get('/:id', (req, res) => {
  const ag = agRow(req.params.id);
  if (!ag || ag.user_id !== req.user.id || ag.status === 'void') return res.status(404).json({ error: 'Not found.' });
  const u = req.user;
  let prefill = {};
  if (ag.kind !== 'custom') {
    const prev = db.prepare("SELECT fields FROM agreements WHERE user_id = ? AND kind != 'custom' AND fields IS NOT NULL ORDER BY id DESC LIMIT 1").get(u.id);
    prefill = prev ? JSON.parse(prev.fields) : { name: u.name || '', email: u.email || '', phone: u.phone || '' };
  }
  if (ag.status === 'pending') {
    const last = db.prepare("SELECT at FROM agreement_events WHERE agreement_id = ? AND action = 'Opened the document' ORDER BY at DESC LIMIT 1").get(ag.id);
    if (!last || last.at < Date.now() - 30 * 60000) AG.logEvent(ag.id, u.name || u.uid, 'Opened the document', null, req.ip);
  }
  const tpl = AG.templateById(ag.template_id) || {};
  const cs = AG.companySettings();
  res.json({
    agreement: AG.publicAgreement(ag),
    spec: { title: AG.titleOf(ag), pages: tpl.pages, custom: ag.kind === 'custom', fields: AG.fieldsOf(ag) },
    prefill, tickets: AG.TICKETS, consent: AG.CONSENT,
    company: { signer: `${cs.signer_name}, ${cs.signer_title}` },
  });
});

member.get('/:id/document', (req, res) => {
  const ag = agRow(req.params.id);
  if (!ag || ag.user_id !== req.user.id || ag.status === 'void') return res.status(404).json({ error: 'Not found.' });
  if (ag.status === 'executed') return sendPdf(res, ag.executed_name, fileTitle(ag), req.query.download === '1');
  const tpl = AG.templateById(ag.template_id);
  if (!tpl) return res.status(404).json({ error: 'Template missing.' });
  sendPdf(res, tpl.stored_name, `${AG.titleOf(ag)}.pdf`, false);
});

member.post('/:id/sign', async (req, res) => {
  const ag = agRow(req.params.id);
  if (!ag || ag.user_id !== req.user.id || ag.status === 'void') return res.status(404).json({ error: 'Not found.' });
  if (ag.status !== 'pending') return res.status(409).json({ error: 'This agreement has already been signed.' });
  const { fields, errors } = AG.validateFields(ag, req.body.fields || {});
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
  const actor = fields.name || req.user.name || req.user.uid;
  db.prepare(`UPDATE agreements SET fields = ?, member_sig = ?, member_signed_at = ?, member_place = ?, member_geo = ?, member_ip = ?, member_ua = ?, status = 'member_signed', updated_at = ? WHERE id = ? AND status = 'pending'`)
    .run(JSON.stringify(fields), sigFile, now, place, geo ? JSON.stringify(geo) : null, req.ip, str(req.get('user-agent') || '', 300), now, ag.id);
  AG.logEvent(ag.id, actor, 'Filled in the details and signed', `place: ${place}${geo ? ', location shared' : ''}`, req.ip);
  A.logAccess(req.user.id, 'agreement_signed', AG.titleOf(ag));
  if (fields.name) db.prepare("UPDATE users SET name = ?, phone = COALESCE(NULLIF(phone, ''), ?) WHERE id = ?").run(fields.name, fields.phone || null, req.user.id);

  const cs = AG.companySettings();
  let result = { executed: false, upgraded: false };
  try {
    if (cs.auto && cs.signature) {
      const { done, upgraded } = await executeAndNotify(agRow(ag.id), { method: 'auto', place: cs.place, sigFile: cs.signature, ip: null, actor: 'VINC Global' });
      result = { executed: done.status === 'executed', upgraded };
    } else {
      notify.agreementSignedAdmin(userRow(req.user.id), { ...agRow(ag.id), signedAt: AG.istDateTime(now) }, AG.titleOf(ag));
    }
  } catch (e) {
    console.error('[agreements] execution failed', e);
  }
  res.json({ ...result, user: A.publicUser(userRow(req.user.id)), ...memberList(userRow(req.user.id)) });
});

// ================================================================== admin
function standardInfo(kind) {
  const t = AG.activeTemplate(kind);
  const base = { kind, title: AG.KINDS[kind].title, required_for: kind === 'term_sheet' ? 'Advisors and investors' : 'Advisors' };
  if (!t) return { ...base, uploaded: false };
  return { ...base, uploaded: true, id: t.id, original_name: t.original_name, pages: t.pages, uploaded_at: t.uploaded_at, sha256: t.sha256, matches_layout: t.sha256 === AG.KINDS[kind].sha256 };
}
function customInfo(t) {
  const counts = db.prepare(`SELECT status, COUNT(*) AS n FROM agreements WHERE template_id = ? AND status != 'void' GROUP BY status`).all(t.id);
  const by = Object.fromEntries(counts.map((c) => [c.status, c.n]));
  const blanks = t.fields ? JSON.parse(t.fields) : [];
  return {
    id: t.id, kind: 'custom', title: t.title, original_name: t.original_name, pages: t.pages, uploaded_at: t.uploaded_at, required: !!t.required,
    blanks: blanks.length, used_blanks: blanks.filter((b) => b.mode !== 'skip').length,
    sent: (by.pending || 0) + (by.member_signed || 0) + (by.executed || 0), executed: by.executed || 0,
  };
}

admin.get('/', (_req, res) => {
  const cs = AG.companySettings();
  const members = db.prepare("SELECT * FROM users WHERE role != 'admin' AND status != 'invited' ORDER BY name COLLATE NOCASE").all();
  const rows = [];
  for (const u of members) {
    const ags = db.prepare("SELECT * FROM agreements WHERE user_id = ? AND status != 'void' ORDER BY id").all(u.id);
    for (const a of ags) rows.push({ user: A.publicUser(u), ...AG.publicAgreement(a, { admin: true }) });
    for (const kind of AG.kindsForRole(u.role)) {
      if (!ags.some((a) => a.kind === kind)) rows.push({ user: A.publicUser(u), kind, title: AG.KINDS[kind].title, status: 'not_sent', mandatory: true });
    }
  }
  const order = { member_signed: 0, pending: 1, not_sent: 2, executed: 3 };
  rows.sort((a, b) => (order[a.status] - order[b.status]) || String(a.user.name || '').localeCompare(String(b.user.name || '')));
  res.json({
    templates: [standardInfo('advisory'), standardInfo('term_sheet')],
    custom: db.prepare("SELECT * FROM agreement_templates WHERE kind = 'custom' AND active = 1 ORDER BY id DESC").all().map(customInfo),
    company: { signer_name: cs.signer_name, signer_title: cs.signer_title, place: cs.place, auto: cs.auto, has_signature: !!cs.signature, signature_set_at: cs.signature_set_at },
    members: members.map((u) => ({ id: u.id, uid: u.uid, name: u.name, role: u.role, state: A.accessState(u), access_type: u.access_type })),
    rows,
  });
});

async function readPdf(req, res) {
  if (!req.file) { res.status(400).json({ error: 'Choose the PDF to upload.' }); return null; }
  const buf = fs.readFileSync(up.storedPath(req.file.filename));
  try { const pages = (await PDFDocument.load(buf)).getPageCount(); return { buf, pages }; }
  catch { up.removeStored(req.file.filename); res.status(400).json({ error: 'This PDF could not be read.' }); return null; }
}

// The two standard documents
admin.post('/templates/:kind', up.single('pdf'), async (req, res) => {
  const kind = req.params.kind;
  if (!AG.KINDS[kind]) { if (req.file) up.removeStored(req.file.filename); return res.status(404).json({ error: 'Unknown document.' }); }
  const r = await readPdf(req, res); if (!r) return;
  if (r.pages !== AG.KINDS[kind].pages) {
    up.removeStored(req.file.filename);
    return res.status(400).json({ error: `The ${AG.KINDS[kind].title} should have ${AG.KINDS[kind].pages} pages; this file has ${r.pages}. The blanks are placed for the ${AG.KINDS[kind].pages}-page version.` });
  }
  tx(() => {
    db.prepare('UPDATE agreement_templates SET active = 0 WHERE kind = ?').run(kind);
    db.prepare('INSERT INTO agreement_templates (kind, title, stored_name, original_name, sha256, pages, active, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
      .run(kind, AG.KINDS[kind].title, req.file.filename, req.file.originalname.slice(0, 200), AG.sha256(r.buf), r.pages, Date.now());
  });
  res.json(standardInfo(kind));
});

admin.get('/templates/:kind/raw', (req, res) => {
  const t = /^\d+$/.test(req.params.kind) ? AG.templateById(Number(req.params.kind)) : AG.activeTemplate(req.params.kind);
  if (!t) return res.status(404).json({ error: 'Not uploaded yet.' });
  sendPdf(res, t.stored_name, t.original_name || 'template.pdf', false);
});

// Any other agreement
admin.post('/custom', up.single('pdf'), async (req, res) => {
  const title = str(req.body.title, 120);
  if (!title || !AG.SAFE.test(title)) { if (req.file) up.removeStored(req.file.filename); return res.status(400).json({ error: 'Give the agreement a title (English letters).' }); }
  const r = await readPdf(req, res); if (!r) return;
  let found = { blanks: [] };
  try { found = await AG.detectBlanks(r.buf); } catch (e) { console.error('[agreements] blank detection failed', e.message); }
  const blanks = found.blanks.map((b) => ({ ...b, mode: AG.suggestMode(b.hint), label: (b.hint || '').replace(/[\s:.-]+$/, '') || `Blank ${b.id}`, value: '' }));
  const info = db.prepare("INSERT INTO agreement_templates (kind, title, stored_name, original_name, sha256, pages, fields, required, active, uploaded_at) VALUES ('custom', ?, ?, ?, ?, ?, ?, ?, 1, ?)")
    .run(title, req.file.filename, req.file.originalname.slice(0, 200), AG.sha256(r.buf), r.pages, JSON.stringify(blanks), req.body.required === 'true' || req.body.required === '1' ? 1 : 0, Date.now());
  res.json(customDetail(AG.templateById(info.lastInsertRowid)));
});

function customDetail(t) {
  return { ...customInfo(t), blanks_list: t.fields ? JSON.parse(t.fields) : [], modes: AG.MODES };
}

admin.get('/custom/:id', (req, res) => {
  const t = AG.templateById(Number(req.params.id));
  if (!t || t.kind !== 'custom') return res.status(404).json({ error: 'Not found.' });
  res.json(customDetail(t));
});

admin.put('/custom/:id', (req, res) => {
  const t = AG.templateById(Number(req.params.id));
  if (!t || t.kind !== 'custom') return res.status(404).json({ error: 'Not found.' });
  const title = req.body.title !== undefined ? str(req.body.title, 120) : t.title;
  if (!title || !AG.SAFE.test(title)) return res.status(400).json({ error: 'Give the agreement a title (English letters).' });
  const blanks = t.fields ? JSON.parse(t.fields) : [];
  const incoming = Array.isArray(req.body.blanks) ? req.body.blanks : [];
  for (const b of blanks) {
    const c = incoming.find((x) => Number(x.id) === b.id);
    if (!c) continue;
    if (AG.MODES[c.mode]) b.mode = c.mode;
    const label = str(c.label, 60), value = str(c.value, 120);
    if (!AG.SAFE.test(label) || !AG.SAFE.test(value)) return res.status(400).json({ error: 'Please use English letters only.' });
    b.label = label || b.hint || `Blank ${b.id}`;
    b.value = value;
    if (b.mode === 'company' && !b.value) return res.status(400).json({ error: `Type the fixed text for “${b.label}”, or choose another option for it.` });
  }
  const signedAlready = db.prepare("SELECT COUNT(*) AS n FROM agreements WHERE template_id = ? AND status IN ('member_signed','executed')").get(t.id).n;
  if (signedAlready && req.body.blanks) return res.status(409).json({ error: 'Someone has already signed this agreement, so its blanks can no longer change. Upload it again as a new agreement instead.' });
  const required = req.body.required !== undefined ? (req.body.required ? 1 : 0) : t.required;
  db.prepare('UPDATE agreement_templates SET title = ?, fields = ?, required = ? WHERE id = ?').run(title, JSON.stringify(blanks), required, t.id);
  db.prepare("UPDATE agreements SET mandatory = ? WHERE template_id = ? AND status IN ('pending','member_signed')").run(required, t.id);
  res.json(customDetail(AG.templateById(t.id)));
});

admin.delete('/custom/:id', (req, res) => {
  const t = AG.templateById(Number(req.params.id));
  if (!t || t.kind !== 'custom') return res.status(404).json({ error: 'Not found.' });
  const open = db.prepare("SELECT id FROM agreements WHERE template_id = ? AND status IN ('pending','member_signed')").all(t.id);
  tx(() => {
    db.prepare('UPDATE agreement_templates SET active = 0 WHERE id = ?').run(t.id);
    for (const a of open) {
      db.prepare("UPDATE agreements SET status = 'void', void_reason = 'Withdrawn by VINC', updated_at = ? WHERE id = ?").run(Date.now(), a.id);
      AG.logEvent(a.id, 'Admin', 'Voided', 'agreement withdrawn', req.ip);
    }
  });
  res.json({ ok: true, withdrawn: open.length });
});

// Send a document to one member, several, or a whole group.
admin.post('/send', (req, res) => {
  const b = req.body || {};
  const tpl = b.template_id ? AG.templateById(Number(b.template_id)) : AG.activeTemplate(b.kind);
  if (!tpl || !tpl.active) return res.status(400).json({ error: b.kind && AG.KINDS[b.kind] ? `Upload the ${AG.KINDS[b.kind].title} first.` : 'Choose an agreement to send.' });
  let users;
  const base = "SELECT * FROM users WHERE role != 'admin' AND status NOT IN ('invited','rejected','revoked')";
  if (b.audience === 'advisors') users = db.prepare(base + " AND role = 'advisor'").all();
  else if (b.audience === 'investors') users = db.prepare(base + " AND role = 'investor'").all();
  else if (b.audience === 'all') users = db.prepare(base).all();
  else {
    const ids = (Array.isArray(b.user_ids) ? b.user_ids : [b.user_id]).map(Number).filter(Boolean).slice(0, 1000);
    users = ids.map(userRow).filter((u) => u && u.role !== 'admin');
  }
  if (!users.length) return res.status(400).json({ error: 'Choose at least one member.' });
  let sent = 0, reminded = 0, skipped = 0, emailed = 0;
  for (const u of users) {
    const { agreement, created } = AG.ensureFor(u, tpl, 'Admin');
    if (!agreement) { skipped++; continue; }
    if (!created && agreement.status !== 'pending') { skipped++; continue; }
    AG.logEvent(agreement.id, 'Admin', created ? 'Sent for signature' : 'Reminder sent', null, req.ip);
    if (created) sent++; else reminded++;
    if (notify.agreementReady(u, AG.titleOf(tpl))) emailed++;
  }
  res.json({ sent, reminded, skipped, emailed });
});

admin.get('/:id', (req, res) => {
  const ag = agRow(req.params.id);
  if (!ag) return res.status(404).json({ error: 'Not found.' });
  const cs = AG.companySettings();
  res.json({
    agreement: AG.publicAgreement(ag, { admin: true }),
    labels: Object.fromEntries(AG.fieldsOf(ag).filter((f) => f.src === 'member' && !f.type).map((f) => [f.key, f.label])),
    user: A.publicUser(userRow(ag.user_id)),
    events: db.prepare('SELECT at, actor, action, detail, ip FROM agreement_events WHERE agreement_id = ? ORDER BY at, id').all(ag.id),
    company: { signer_name: cs.signer_name, signer_title: cs.signer_title, place: cs.place, auto: cs.auto, has_signature: !!cs.signature },
  });
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

admin.get('/:id/member-signature', (req, res) => {
  const ag = agRow(req.params.id);
  if (!ag || !ag.member_sig) return res.status(404).json({ error: 'Not signed yet.' });
  res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(AG.filePath(ag.member_sig)).pipe(res);
});

admin.get('/:id/pdf', async (req, res) => {
  const ag = agRow(req.params.id);
  if (!ag) return res.status(404).json({ error: 'Not found.' });
  if (ag.status === 'executed') return sendPdf(res, ag.executed_name, fileTitle(ag), req.query.download === '1');
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
  const tpl = ag.kind === 'custom' ? AG.templateById(ag.template_id) : AG.activeTemplate(ag.kind);
  if (tpl && tpl.active) AG.ensureFor(u, tpl, 'Admin');       // a fresh copy, ready to sign again
  notify.agreementVoided(u, AG.titleOf(ag), reason);
  res.json({ ok: true });
});

module.exports = { member, admin, upgradeIfComplete };
