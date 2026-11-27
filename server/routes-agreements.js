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
member.use(A.requireSigner);   // members, and view-only accounts (directors, company secretary, staff) asked to sign
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
  if (!u || !A.isMember(u)) return false;
  if (u.status === 'active' && u.access_type === 'permanent') return false;
  const now = Date.now();
  db.prepare("UPDATE users SET status = 'active', access_type = 'permanent', access_expires_at = NULL, approved_at = ?, renewal_requested = 0 WHERE id = ?").run(now, userId);
  A.logAccess(userId, 'approved_permanent', 'agreements signed');
  notify.approved(userRow(userId));
  return true;
}

/** Check the values the company fills in at countersigning; returns { values, error }. */
function readCompanyInputs(ag, input) {
  const values = {};
  for (const { key } of AG.companyInputs(ag)) {
    let v = str(input && input[key] !== undefined ? String(input[key]) : '', 40);
    if (key === 'disburse_days') {
      v = v.replace(/[^\d]/g, '');
      if (!(Number(v) >= 1 && Number(v) <= 365)) return { error: 'Enter the disbursement period in days (1 to 365).' };
    } else if (v.length < 4 || !AG.SAFE.test(v)) return { error: 'Enter the date of the special resolution, for example 15 October 2026.' };
    values[key] = v;
  }
  return { values };
}

async function executeAndNotify(ag, opts) {
  const done = await AG.execute(ag, opts);
  let upgraded = false;
  // Every signer (one, or all signers of a joint agreement) gets the signed PDF.
  for (const r of AG.jointRows(done)) {
    const u = userRow(r.user_id);
    A.logAccess(u.id, 'agreement_executed', AG.titleOf(r));
    notify.agreementExecuted(u, r, AG.titleOf(r), AG.filePath(r.executed_name));
    const up = upgradeIfComplete(u.id);
    if (r.id === done.id) upgraded = up;
  }
  return { done, upgraded };
}

// ================================================================== member
function memberList(u) {
  AG.ensureRole(u);
  const rows = db.prepare("SELECT * FROM agreements WHERE user_id = ? AND status != 'void' ORDER BY mandatory DESC, id").all(u.id);
  const voided = db.prepare("SELECT kind, template_id, void_reason FROM agreements WHERE user_id = ? AND status = 'void' ORDER BY id DESC").all(u.id);
  return {
    agreements: rows.map((r) => {
      const v = voided.find((x) => x.template_id === r.template_id && !String(x.void_reason || '').startsWith(AG.NOT_NEEDED));
      return { ...AG.publicAgreement(r), last_void_reason: (v && v.void_reason) || null };
    }),
    groups: Object.fromEntries(Object.entries(AG.GROUPS).map(([k, g]) => [k, { title: g.title, kinds: g.kinds }])),
    waiting_for_template: A.isMember(u) && !rows.length && !AG.kindsFor(u).some((k) => AG.readyTemplate(k)),
    viewer: u.role === 'viewer',
    steam_ie: u.investor_type === 'steam_ie',
    all_executed: AG.requiredDone(u.id),
  };
}

member.get('/', (req, res) => res.json(memberList(req.user)));

member.get('/:id', (req, res) => {
  const ag = agRow(req.params.id);
  if (!ag || ag.user_id !== req.user.id || ag.status === 'void') return res.status(404).json({ error: 'Not found.' });
  const u = req.user;
  let prefill = {};
  if (!AG.blanksMode(ag)) {
    const prev = db.prepare("SELECT fields FROM agreements WHERE user_id = ? AND kind IN ('advisory','term_sheet','member_loan') AND fields LIKE '%\"pan\"%' ORDER BY id DESC LIMIT 1").get(u.id);
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
    spec: { title: AG.titleOf(ag), pages: tpl.pages, custom: AG.blanksMode(ag), fields: AG.fieldsOf(ag) },
    prefill, tickets: AG.TICKETS, consent: AG.CONSENT,
    company: { signer: `${cs.signer_name}, ${cs.signer_title}` },
  });
});

member.get('/:id/document', async (req, res) => {
  const ag = agRow(req.params.id);
  if (!ag || ag.user_id !== req.user.id || ag.status === 'void') return res.status(404).json({ error: 'Not found.' });
  if (ag.status === 'executed') return sendPdf(res, ag.executed_name, fileTitle(ag), req.query.download === '1');
  const tpl = AG.templateById(ag.template_id);
  if (!tpl) return res.status(404).json({ error: 'Template missing.' });
  if (ag.status === 'pending' && req.get('range') === undefined) {
    // Reading the document before signing is part of the audit trail (once per half hour).
    const last = db.prepare("SELECT at FROM agreement_events WHERE agreement_id = ? AND action IN ('Opened the document','Viewed the document') ORDER BY at DESC LIMIT 1").get(ag.id);
    if (!last || last.at < Date.now() - 30 * 60000) AG.logEvent(ag.id, req.user.name || req.user.uid, 'Viewed the document', null, req.ip);
  }
  if (ag.status === 'member_signed') {
    // Their own filled-in, signed copy (VINC's signature is added when it countersigns).
    try {
      const bytes = await AG.buildPdf(ag, { withCompany: false, certificate: false });
      res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Cache-Control', 'no-store, private');
      res.setHeader('Content-Disposition', 'inline; filename="signed-copy.pdf"');
      return res.end(bytes);
    } catch { /* fall back to the blank document */ }
  }
  sendPdf(res, tpl.stored_name, `${AG.titleOf(ag)}.pdf`, false);
});

member.post('/:id/sign', async (req, res) => {
  const ag = agRow(req.params.id);
  if (!ag || ag.user_id !== req.user.id || ag.status === 'void') return res.status(404).json({ error: 'Not found.' });
  if (ag.status !== 'pending') return res.status(409).json({ error: 'This agreement has already been signed.' });
  if (!AG.isReady(AG.templateById(ag.template_id))) return res.status(409).json({ error: 'VINC is updating this document. Please check back shortly.' });
  const g = AG.groupOf(ag.kind);
  const chosen = g && AG.chosenIn(req.user.id, AG.GROUPS[g].kinds);
  if (chosen) return res.status(409).json({ error: `You have already signed the ${AG.titleOf(chosen)}, so this one is not needed.` });
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
  AG.closeSiblings(ag, req.ip);      // the other choices of a "one of" group are no longer needed
  A.logAccess(req.user.id, 'agreement_signed', AG.titleOf(ag));
  if (fields.name) db.prepare("UPDATE users SET name = ?, phone = COALESCE(NULLIF(phone, ''), ?) WHERE id = ?").run(fields.name, fields.phone || null, req.user.id);

  const cs = AG.companySettings();
  let result = { executed: false, upgraded: false };
  try {
    const signedRow = agRow(ag.id);
    if (!AG.jointComplete(signedRow)) {
      // A joint agreement: the others still have to sign; the company countersigns once everyone has.
      return res.json({ ...result, waiting_for_others: true, user: A.publicUser(userRow(req.user.id)), ...memberList(userRow(req.user.id)) });
    }
    const needs = AG.companyInputs(ag);
    const defaults = AG.companyDefaults();
    const autoOk = cs.auto && cs.signature && needs.every((n) => defaults[n.key]);
    if (autoOk) {
      if (needs.length) db.prepare('UPDATE agreements SET company_fields = ? WHERE id = ?').run(JSON.stringify(Object.fromEntries(needs.map((n) => [n.key, defaults[n.key]]))), ag.id);
      const { done, upgraded } = await executeAndNotify(agRow(ag.id), { method: 'auto', place: cs.place, sigFile: cs.signature, ip: null, actor: 'VINC Global' });
      result = { executed: done.status === 'executed', upgraded };
    } else {
      const j = AG.jointInfo(agRow(ag.id));
      notify.agreementSignedAdmin(userRow(req.user.id), { ...agRow(ag.id), signedAt: AG.istDateTime(now), joint: j }, AG.titleOf(ag));
    }
  } catch (e) {
    console.error('[agreements] execution failed', e);
  }
  res.json({ ...result, user: A.publicUser(userRow(req.user.id)), ...memberList(userRow(req.user.id)) });
});

// ================================================================== admin
const STANDARD = Object.keys(AG.KINDS).filter((k) => !AG.KINDS[k].retired);
function standardInfo(kind) {
  const t = AG.activeTemplate(kind);
  const g = AG.groupOf(kind);
  const REQUIRED_FOR = { advisory: 'Advisors', term_sheet: 'Required: Investors · Advisors: this or the Member Loan Agreement', member_loan: 'Advisors: this or the Investor Term Sheet' };
  const base = { kind, title: AG.KINDS[kind].title, group: g, required_for: REQUIRED_FOR[kind] || '' };
  if (!t) return { ...base, uploaded: false };
  const blanks = t.fields ? JSON.parse(t.fields) : [];
  return {
    ...base, uploaded: true, id: t.id, original_name: t.original_name, pages: t.pages, uploaded_at: t.uploaded_at, sha256: t.sha256,
    layout: AG.usesBlanks(t) ? 'blanks' : 'measured', ready: AG.isReady(t),
    blanks: blanks.length, used_blanks: blanks.filter((b) => b.mode !== 'skip').length,
  };
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
  const members = db.prepare("SELECT * FROM users WHERE role IN ('advisor','investor','viewer') AND status != 'invited' ORDER BY name COLLATE NOCASE").all();
  const rows = [];
  for (const u of members) {
    const ags = db.prepare("SELECT * FROM agreements WHERE user_id = ? AND status != 'void' ORDER BY id").all(u.id);
    for (const a of ags) rows.push({ user: A.publicUser(u), ...AG.publicAgreement(a, { admin: true }) });
    for (const req of AG.reqsFor(u)) {
      const kinds = AG.expand(req).filter((k) => AG.readyTemplate(k));
      if (AG.GROUPS[req] && ags.some((a) => kinds.includes(a.kind))) continue;   // a choice is already in front of them
      for (const kind of kinds) {
        if (!ags.some((a) => a.kind === kind)) rows.push({ user: A.publicUser(u), kind, title: AG.KINDS[kind].title, group: AG.groupOf(kind), status: 'not_sent', mandatory: true });
      }
    }
  }
  const order = { member_signed: 0, pending: 1, not_sent: 2, executed: 3 };
  rows.sort((a, b) => (order[a.status] - order[b.status]) || String(a.user.name || '').localeCompare(String(b.user.name || '')));
  res.json({
    templates: STANDARD.map(standardInfo),
    groups: AG.GROUPS,
    custom: db.prepare("SELECT * FROM agreement_templates WHERE kind = 'custom' AND active = 1 ORDER BY id DESC").all().map(customInfo),
    company: { signer_name: cs.signer_name, signer_title: cs.signer_title, place: cs.place, auto: cs.auto, has_signature: !!cs.signature, signature_set_at: cs.signature_set_at },
    loan_terms: (() => { const st = require('./db').getSettings(); return { resolution_date: st.loan_resolution_date || '', disburse_days: st.loan_disburse_days || '' }; })(),
    members: members.map((u) => ({ id: u.id, uid: u.uid, name: u.name, role: u.role, investor_type: u.investor_type || null, designation: u.role === 'viewer' ? (u.organisation || '') : null, label: A.memberLabel(u), state: A.accessState(u), access_type: u.access_type })),
    rows,
  });
});

async function readPdf(req, res) {
  if (!req.file) { res.status(400).json({ error: 'Choose the PDF to upload.' }); return null; }
  const buf = fs.readFileSync(up.storedPath(req.file.filename));
  try { const pages = (await PDFDocument.load(buf)).getPageCount(); return { buf, pages }; }
  catch (e) {
    up.removeStored(req.file.filename);
    const locked = /encrypt/i.test(String(e && e.message));
    res.status(400).json({ error: locked ? 'This PDF is password-protected. Save a copy without a password and upload that.' : 'This PDF could not be read. Try saving it again as a PDF.' });
    return null;
  }
}

/** Blanks found in the PDF (in a worker thread), or none if it could not be read; never stops the upload. */
async function findBlanks(buf) {
  try { return { blanks: AG.suggestBlanks((await AG.detectBlanks(buf)).blanks), error: null }; }
  catch (e) { console.error('[agreements] blank detection failed:', e.message); return { blanks: [], error: e.message }; }
}

// The standard documents. The exact files the positions were measured on are ready at once; any other file
// (a new version, or a document without measured positions) has its blanks found, and the admin sets them up.
admin.post('/templates/:kind', up.single('pdf'), async (req, res) => {
  const kind = req.params.kind;
  if (!AG.KINDS[kind]) { if (req.file) up.removeStored(req.file.filename); return res.status(404).json({ error: 'Unknown document.' }); }
  const r = await readPdf(req, res); if (!r) return;
  const sha = AG.sha256(r.buf);
  if (AG.KINDS[kind].retired) { up.removeStored(req.file.filename); return res.status(400).json({ error: 'This agreement is no longer used.' }); }
  const measured = !!AG.measuredFields({ kind, sha256: sha });
  const found = measured ? { blanks: [], error: null } : await findBlanks(r.buf);
  let id;
  tx(() => {
    db.prepare('UPDATE agreement_templates SET active = 0 WHERE kind = ?').run(kind);
    id = db.prepare('INSERT INTO agreement_templates (kind, title, stored_name, original_name, sha256, pages, fields, ready, active, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)')
      .run(kind, AG.KINDS[kind].title, req.file.filename, req.file.originalname.slice(0, 200), sha, r.pages, measured ? null : JSON.stringify(found.blanks), measured ? 1 : 0, Date.now()).lastInsertRowid;
    // Copies nobody has signed yet move to the new version.
    for (const a of db.prepare("SELECT id FROM agreements WHERE kind = ? AND status = 'pending'").all(kind)) {
      db.prepare('UPDATE agreements SET template_id = ?, updated_at = ? WHERE id = ?').run(id, Date.now(), a.id);
      AG.logEvent(a.id, 'Admin', 'Document updated to the latest version', req.file.originalname.slice(0, 80), req.ip);
    }
  });
  res.json({ ...standardInfo(kind), needs_setup: !measured, detect_error: found.error });
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
  const { blanks, error } = await findBlanks(r.buf);
  const info = db.prepare("INSERT INTO agreement_templates (kind, title, stored_name, original_name, sha256, pages, fields, required, active, uploaded_at) VALUES ('custom', ?, ?, ?, ?, ?, ?, ?, 1, ?)")
    .run(title, req.file.filename, req.file.originalname.slice(0, 200), AG.sha256(r.buf), r.pages, JSON.stringify(blanks), 1, Date.now());
  res.json({ ...customDetail(AG.templateById(info.lastInsertRowid)), detect_error: error });
});

function customDetail(t) {
  const standard = t.kind !== 'custom';
  const info = standard ? { id: t.id, kind: t.kind, title: AG.KINDS[t.kind].title, original_name: t.original_name, pages: t.pages, uploaded_at: t.uploaded_at, required: true } : customInfo(t);
  return { ...info, standard, ready: AG.isReady(t), blanks_list: t.fields ? JSON.parse(t.fields) : [], modes: AG.MODES };
}
// Templates whose blanks the admin sets up: custom agreements, and standard documents without measured positions.
const setupTemplate = (id) => { const t = AG.templateById(Number(id)); return t && t.active && AG.usesBlanks(t) ? t : null; };

admin.get('/custom/:id', async (req, res) => {
  let t = setupTemplate(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found.' });
  if (AG.needsBlanks(t)) t = await AG.prepareStandard(t);   // a file replaced before blanks were found automatically
  res.json(customDetail(t));
});

admin.put('/custom/:id', (req, res) => {
  const t = setupTemplate(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found.' });
  if (AG.needsBlanks(t)) return res.status(409).json({ error: 'Open Set up blanks again so the blanks can be found first.' });
  const standard = t.kind !== 'custom';
  const title = standard ? t.title : req.body.title !== undefined ? str(req.body.title, 120) : t.title;
  if (!title || !AG.SAFE.test(title)) return res.status(400).json({ error: 'Give the agreement a title (English letters).' });
  let blanks = t.fields ? JSON.parse(t.fields) : [];
  const incoming = Array.isArray(req.body.blanks) ? req.body.blanks : [];
  if (Array.isArray(req.body.blanks)) {
    // Blanks the admin placed by hand: removed ones go, new ones are added, and their width can change.
    const num = (v) => Math.round(Number(v) * 10) / 10;
    blanks = blanks.filter((b) => !b.manual || incoming.some((x) => Number(x.id) === b.id));
    for (const c of incoming) {
      if (!c.manual) continue;
      const page = Math.round(Number(c.page)), x = num(c.x), w = num(c.w), line = num(c.line);
      if (!(page >= 1 && page <= (t.pages || 1)) || ![x, w, line].every(Number.isFinite) || x < 0 || x > 1500 || w < 10 || w > 700 || line < 5 || line > 2500) {
        return res.status(400).json({ error: 'A blank you added is outside the page. Remove it and add it again.' });
      }
      const existing = blanks.find((b) => b.id === Number(c.id));
      if (existing) { if (existing.manual) Object.assign(existing, { page, x, w, line }); continue; }
      const id = Math.max(0, ...blanks.map((b) => b.id)) + 1;
      c.id = id;
      blanks.push({ id, page, x, w, line, hint: 'Added by you', source: 'manual', manual: true, mode: 'member', label: '', value: '' });
    }
    if (blanks.length > 600) return res.status(400).json({ error: 'That is too many blanks for one document.' });
  }
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
  if (standard) {
    // Saving the set-up makes the document ready: members can sign it and new members receive it.
    db.prepare('UPDATE agreement_templates SET fields = ?, ready = 1 WHERE id = ?').run(JSON.stringify(blanks), t.id);
    const fresh = AG.templateById(t.id);
    let offered = 0;
    for (const u of db.prepare("SELECT * FROM users WHERE role IN ('advisor','investor') AND status = 'active'").all()) {
      const created = AG.ensureRole(u, 'Admin');
      if (created.length) { offered += created.length; notify.agreementReady(u, AG.describe(created)); }
    }
    return res.json({ ...customDetail(fresh), offered });
  }
  db.prepare('UPDATE agreement_templates SET title = ?, fields = ?, required = 1 WHERE id = ?').run(title, JSON.stringify(blanks), t.id);
  res.json(customDetail(AG.templateById(t.id)));
});

// Find the blanks again (after detection improves), keeping the choices made for blanks found in the same
// place and every blank added by hand.
admin.post('/custom/:id/redetect', async (req, res) => {
  const t = setupTemplate(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found.' });
  const signedAlready = db.prepare("SELECT COUNT(*) AS n FROM agreements WHERE template_id = ? AND status IN ('member_signed','executed')").get(t.id).n;
  if (signedAlready) return res.status(409).json({ error: 'Someone has already signed this agreement, so its blanks can no longer change. Upload it again instead.' });
  const old = t.fields ? JSON.parse(t.fields) : [];
  const { blanks, error } = await findBlanks(fs.readFileSync(AG.filePath(t.stored_name)));
  if (error) return res.status(422).json({ error: 'The blanks could not be read from this PDF. You can still add them by hand.' });
  let kept = 0;
  for (const b of blanks) {
    const was = old.find((o) => !o.manual && o.page === b.page && Math.abs(o.line - b.line) < 3 && Math.abs(o.x - b.x) < 5);
    if (was) { Object.assign(b, { mode: was.mode, label: was.label, value: was.value }); kept++; }
  }
  const manual = old.filter((o) => o.manual).map((o, i) => ({ ...o, id: blanks.length + i + 1 }));
  const all = [...blanks, ...manual];
  db.prepare('UPDATE agreement_templates SET fields = ? WHERE id = ?').run(JSON.stringify(all), t.id);
  res.json({ ...customDetail(AG.templateById(t.id)), found: blanks.length, kept });
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
  if (!AG.isReady(tpl)) return res.status(400).json({ error: `Set up the blanks of the ${AG.titleOf(tpl)} first.` });
  let users;
  const base = "SELECT * FROM users WHERE role IN ('advisor','investor') AND status NOT IN ('invited','rejected','revoked')";
  const staff = "SELECT * FROM users WHERE role = 'viewer' AND status = 'active'";
  if (b.audience === 'directors') users = db.prepare(staff + " AND lower(organisation) LIKE 'director%'").all();
  else if (b.audience === 'viewers') users = db.prepare(staff).all();
  else if (b.audience === 'advisors') users = db.prepare(base + " AND role = 'advisor'").all();
  else if (b.audience === 'investors') users = db.prepare(base + " AND role = 'investor'").all();   // STEAM-IE shareholders included
  else if (b.audience === 'steam_ie') users = db.prepare(base + " AND role = 'investor' AND investor_type = 'steam_ie'").all();
  else if (b.audience === 'all') users = db.prepare(base).all();
  else {
    const ids = (Array.isArray(b.user_ids) ? b.user_ids : [b.user_id]).map(Number).filter(Boolean).slice(0, 1000);
    users = ids.map(userRow).filter((u) => u && A.isSigner(u) && !['invited', 'rejected', 'revoked'].includes(u.status));
  }
  if (!users.length) return res.status(400).json({ error: 'Choose at least one person.' });
  if (b.joint) {
    // Everyone signs one shared copy; the company countersigns once all have signed.
    if (tpl.kind !== 'custom') return res.status(400).json({ error: 'Only other agreements can be signed jointly.' });
    if (users.length < 2) return res.status(400).json({ error: 'Choose at least two people to sign one shared copy.' });
    if (users.length > 40) return res.status(400).json({ error: 'A shared copy can have up to 40 signatories.' });
    const copies = AG.createJoint(users, tpl, 'Admin');
    let emailed = 0;
    for (const u of users) if (notify.agreementReady(u, AG.titleOf(tpl))) emailed++;
    return res.json({ sent: copies.length, reminded: 0, skipped: 0, emailed, joint: copies[0].joint_ref });
  }
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
    company_inputs: AG.companyInputs(ag), company_defaults: AG.companyDefaults(),
    company_fields: ag.company_fields ? JSON.parse(ag.company_fields) : null,
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
  // Member Loan Agreement terms set by the company, printed on every copy.
  if (b.loan_resolution_date !== undefined) {
    const v = str(b.loan_resolution_date, 40);
    if (!AG.SAFE.test(v)) return res.status(400).json({ error: 'Please write the date in English letters and numbers.' });
    set.run('loan_resolution_date', v);
  }
  if (b.loan_disburse_days !== undefined) {
    const v = str(String(b.loan_disburse_days), 4).replace(/[^\d]/g, '');
    if (b.loan_disburse_days !== '' && !(Number(v) >= 1 && Number(v) <= 365)) return res.status(400).json({ error: 'Enter the disbursement period in days (1 to 365).' });
    set.run('loan_disburse_days', v);
  }
  if (b.auto !== undefined) {
    if (b.auto && !AG.companySettings().signature) return res.status(400).json({ error: 'Save the company signature first, then turn on automatic countersigning.' });
    set.run('auto_countersign', b.auto ? '1' : '0');
  }
  const cs = AG.companySettings();
  const st = require('./db').getSettings();
  res.json({ signer_name: cs.signer_name, signer_title: cs.signer_title, place: cs.place, auto: cs.auto, has_signature: !!cs.signature, signature_set_at: cs.signature_set_at,
    loan_resolution_date: st.loan_resolution_date || '', loan_disburse_days: st.loan_disburse_days || '' });
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
  if (!AG.jointComplete(ag)) {
    const waiting = AG.jointInfo(ag).signers.filter((s) => s.status === 'pending').map((s) => s.name).join(', ');
    return res.status(409).json({ error: `Still waiting for ${waiting} to sign this shared copy.` });
  }
  const cs = AG.companySettings();
  const place = str(req.body.place, 60) || cs.place;
  if (!AG.SAFE.test(place)) return res.status(400).json({ error: 'Please write the place in English letters.' });
  const terms = readCompanyInputs(ag, req.body.company_fields || {});
  if (terms.error) return res.status(400).json({ error: terms.error });
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
  if (Object.keys(terms.values).length) db.prepare('UPDATE agreements SET company_fields = ? WHERE id = ?').run(JSON.stringify(terms.values), ag.id);
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
  const reason = str((req.body || {}).reason, 300) || null;
  if (ag.joint_ref) {
    for (const r of AG.jointRows(ag)) {
      db.prepare("UPDATE agreements SET status = 'void', void_reason = ?, updated_at = ? WHERE id = ?").run(reason, Date.now(), r.id);
      AG.logEvent(r.id, 'Admin', 'Voided', reason ? `shared copy: ${reason}` : 'shared copy', req.ip);
      notify.agreementVoided(userRow(r.user_id), AG.titleOf(r), reason);
    }
    return res.json({ ok: true, joint: true });
  }
  db.prepare("UPDATE agreements SET status = 'void', void_reason = ?, updated_at = ? WHERE id = ?").run(reason, Date.now(), ag.id);
  AG.logEvent(ag.id, 'Admin', 'Voided', reason, req.ip);
  const u = userRow(ag.user_id);
  const tpl = ag.kind === 'custom' ? AG.templateById(ag.template_id) : AG.readyTemplate(ag.kind);
  if (tpl && tpl.active) AG.ensureFor(u, tpl, 'Admin');       // a fresh copy, ready to sign again
  AG.ensureRole(u, 'Admin');                                  // and the other choices of its group, if any
  notify.agreementVoided(u, AG.titleOf(ag), reason);
  res.json({ ok: true });
});

module.exports = { member, admin, upgradeIfComplete };
