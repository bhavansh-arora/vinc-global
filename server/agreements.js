'use strict';
// Onboarding agreements: the Advisory Agreement (advisors) and the Investor Term Sheet (investors).
// The admin uploads the two PDFs once (they are not kept in the repository). Members fill the blanks and sign;
// the company countersigns (by hand, or automatically with its saved signature). The executed PDF is the
// original document with the blanks filled, both signatures, a reference on every page and a signature
// certificate page with date, time, place, IP and the audit trail. When all of a member's agreements are
// executed, the member becomes permanent.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { db, UPLOAD_DIR, getSettings } = require('./db');

// ------------------------------------------------------------------ field positions
// Coordinates are PDF points from the top-left of the page (as pdftotext reports them).
// `line` is the bottom of the printed underline; text sits just above it.
// They were measured on the templates whose SHA-256 is listed; another file with the same layout works too,
// and the admin page warns when an uploaded file differs.
const KINDS = {
  advisory: {
    title: 'Advisory Agreement', role: 'advisor', pages: 6,
    sha256: '891e8dd2ee19def180d14ff6ed2ca0e2c2cb2d6dc758384fc2106f6906d01c18',
    fields: [
      { key: 'date_day', page: 1, x: 115.5, w: 30.8, line: 171.8, src: 'auto', align: 'center', label: 'Day' },
      { key: 'date_month', page: 1, x: 190.7, w: 107, line: 171.8, src: 'auto', align: 'center', label: 'Month' },
      { key: 'date_year', page: 1, x: 320, w: 24, line: 171.8, src: 'auto', label: 'Year' },
      { key: 'name', page: 1, x: 285.1, w: 231.5, line: 247.7, src: 'member', label: 'Full name' },
      { key: 'relation', page: 1, x: 285.1, w: 231.5, line: 277.9, src: 'member', label: 'S/o / D/o / W/o' },
      { key: 'address1', page: 1, x: 285.1, w: 231.5, line: 308.1, src: 'member', label: 'Address line 1' },
      { key: 'address2', page: 1, x: 285.1, w: 231.5, line: 324.7, src: 'member', label: 'Address line 2' },
      { key: 'pan', page: 1, x: 285.1, w: 231.5, line: 355.2, src: 'member', label: 'PAN' },
      { key: 'email', page: 1, x: 285.1, w: 231.5, line: 385.4, src: 'member', label: 'Email' },
      { key: 'phone', page: 1, x: 285.1, w: 231.5, line: 415.7, src: 'member', label: 'Phone' },
      { key: 'company_sig', page: 6, x: 140, w: 165, line: 313, h: 34, src: 'company', type: 'signature', label: 'Company signature' },
      { key: 'company_date', page: 6, x: 79.2, w: 231.5, line: 379.2, src: 'company', label: 'Company date' },
      { key: 'company_place', page: 6, x: 79.2, w: 231.5, line: 409.4, src: 'company', label: 'Company place' },
      { key: 'member_sig', page: 6, x: 385, w: 165, line: 297, h: 34, src: 'member', type: 'signature', label: 'Your signature' },
      { key: 'member_name', page: 6, x: 324.7, w: 231.5, line: 330.0, src: 'auto', label: 'Name' },
      { key: 'member_date', page: 6, x: 324.7, w: 231.5, line: 376.8, src: 'auto', label: 'Date and time' },
      { key: 'member_place', page: 6, x: 324.7, w: 231.5, line: 407.0, src: 'member', label: 'Place' },
    ],
  },
  term_sheet: {
    title: 'Investor Term Sheet', role: 'investor', pages: 9,
    sha256: 'c1f3cd89185ca98c1a35c2a5d9fc770dae9b3e9f38d067e33fad258e3fc6009e',
    fields: [
      { key: 'date_day', page: 1, x: 453.7, w: 30.9, line: 188.6, src: 'auto', align: 'center', label: 'Day' },
      { key: 'date_month', page: 1, x: 72, w: 107, line: 205.7, src: 'auto', align: 'center', label: 'Month' },
      { key: 'date_year', page: 1, x: 200, w: 24, line: 205.7, src: 'auto', label: 'Year' },
      { key: 'name', page: 1, x: 297.6, w: 208.4, line: 285.6, src: 'member', label: 'Full name' },
      { key: 'relation', page: 1, x: 297.6, w: 208.4, line: 319.9, src: 'member', label: 'S/o / D/o / W/o' },
      { key: 'address1', page: 1, x: 297.6, w: 208.4, line: 354.2, src: 'member', label: 'Address line 1' },
      { key: 'address2', page: 1, x: 297.6, w: 208.4, line: 372.9, src: 'member', label: 'Address line 2' },
      { key: 'pan', page: 1, x: 297.6, w: 208.4, line: 407.3, src: 'member', label: 'PAN' },
      { key: 'email', page: 1, x: 297.6, w: 208.4, line: 441.6, src: 'member', label: 'Email' },
      { key: 'phone', page: 1, x: 297.6, w: 208.4, line: 475.9, src: 'member', label: 'Phone' },
      // Residential status: the option NOT chosen is struck out.
      { key: 'strike_resident', page: 1, x: 398.6, w: 85, line: 489.2, src: 'member', type: 'strike', when: ['residence', 'nonresident'], choose: 'resident', label: 'Resident Indian' },
      { key: 'strike_nonresident', page: 1, x: 297.6, w: 74.1, line: 505, src: 'member', type: 'strike', when: ['residence', 'resident'], choose: 'nonresident', label: 'Non-Resident' },
      // Ticket size boxes.
      { key: 'tick_1', page: 1, x: 211.9, w: 10.4, line: 719.5, h: 12, src: 'member', type: 'tick', when: ['ticket', '1'], label: 'Option 1' },
      { key: 'tick_2', page: 1, x: 211.9, w: 10.4, line: 740.9, h: 12, src: 'member', type: 'tick', when: ['ticket', '2'], label: 'Option 2' },
      { key: 'company_sig', page: 9, x: 130, w: 150, line: 577, h: 32, src: 'company', type: 'signature', label: 'Company signature' },
      { key: 'company_date', page: 9, x: 72, w: 208.4, line: 651.6, src: 'company', label: 'Company date' },
      { key: 'company_place', page: 9, x: 72, w: 208.4, line: 685.9, src: 'company', label: 'Company place' },
      { key: 'member_sig', page: 9, x: 356, w: 150, line: 561, h: 30, src: 'member', type: 'signature', label: 'Your signature' },
      { key: 'member_name', page: 9, x: 297.6, w: 208.4, line: 598.5, src: 'auto', label: 'Name' },
      { key: 'ticket_chosen', page: 9, x: 400, w: 106, line: 617.0, src: 'auto', size: 8.5, label: 'Ticket size chosen' },
      { key: 'member_date', page: 9, x: 297.6, w: 208.4, line: 651.6, src: 'auto', label: 'Date and time' },
      { key: 'member_place', page: 9, x: 297.6, w: 208.4, line: 685.9, src: 'member', label: 'Place' },
    ],
  },
};
const TICKETS = { 1: 'Option 1: Rs. 6,00,000', 2: 'Option 2: Rs. 12,00,000' };
const CONSENT = 'I have read this document in full. I agree to fill it in and sign it electronically, and I accept that my electronic signature is as binding as a handwritten one. I understand that VINC Global records the date and time, the place I enter, my IP address and device, and my location if I choose to share it.';
const kindForRole = (role) => (role === 'investor' ? 'term_sheet' : 'advisory');

// ------------------------------------------------------------------ helpers
const IST = { timeZone: 'Asia/Kolkata' };
function istParts(t) {
  const parts = new Intl.DateTimeFormat('en-GB', { ...IST, day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
    .formatToParts(new Date(t));
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}
const ordinal = (n) => { const d = Number(n); const s = ['th', 'st', 'nd', 'rd'], v = d % 100; return d + (s[(v - 20) % 10] || s[v] || s[0]); };
function istDateTime(t) {
  const p = istParts(t);
  return `${p.day} ${p.month.slice(0, 3)} ${p.year}, ${p.hour}:${p.minute} ${String(p.dayPeriod || '').toUpperCase()} IST`;
}
const utcStamp = (t) => new Date(t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

// Helvetica (the PDF's built-in font) can only write Western characters.
const SAFE = /^[\x20-\x7E -ÿ‘’“”–—…₹]*$/;
const pdfSafe = (s) => String(s == null ? '' : s).replace(/₹/g, 'Rs.').replace(/[^\x20-\x7E -ÿ‘’“”–—…]/g, '?');

function newRef() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let s = '';
    for (const b of crypto.randomBytes(7)) s += a[b % a.length];
    const ref = 'VG-AGR-' + s;
    if (!db.prepare('SELECT 1 FROM agreements WHERE ref = ?').get(ref)) return ref;
  }
}

function saveFile(buf, ext) {
  const name = crypto.randomBytes(18).toString('hex') + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return name;
}
const filePath = (name) => path.join(UPLOAD_DIR, path.basename(name));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** A signature arrives as a PNG data URL from the signature pad. */
function decodeSignature(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 100 || buf.length > 400 * 1024) return null;
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
  return buf;
}

// ------------------------------------------------------------------ member input
function validateFields(kind, input) {
  const v = (k, max = 80) => String((input && input[k]) || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const f = {
    name: v('name'), relation_type: v('relation_type', 3), relation_name: v('relation_name'),
    address1: v('address1', 60), address2: v('address2', 60), pan: v('pan', 10).toUpperCase(),
    email: v('email', 120), phone: v('phone', 20),
  };
  if (kind === 'term_sheet') { f.residence = v('residence', 12); f.ticket = v('ticket', 1); }
  const errors = [];
  if (f.name.length < 2) errors.push('Enter your full name.');
  if (!['S/o', 'D/o', 'W/o'].includes(f.relation_type)) errors.push('Choose S/o, D/o or W/o.');
  if (f.relation_name.length < 2) errors.push("Enter your father's or spouse's name.");
  if (f.address1.length < 4) errors.push('Enter your address.');
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(f.pan)) errors.push('Enter a valid PAN, like ABCDE1234F.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) errors.push('Enter a valid email address.');
  if (!/^[+0-9][0-9 ()-]{6,19}$/.test(f.phone)) errors.push('Enter a valid phone number.');
  if (kind === 'term_sheet') {
    if (!['resident', 'nonresident'].includes(f.residence)) errors.push('Choose your residential status.');
    if (!['1', '2'].includes(f.ticket)) errors.push('Choose a ticket size.');
  }
  for (const [k, val] of Object.entries(f)) if (!SAFE.test(val)) { errors.push(`Please use English letters only (${k.replace('_', ' ')}).`); break; }
  return { fields: f, errors };
}

/** Text for each field on the document. */
function values(ag, opts = {}) {
  const f = ag.fields ? (typeof ag.fields === 'string' ? JSON.parse(ag.fields) : ag.fields) : {};
  const out = {
    name: f.name, relation: f.relation_type && f.relation_name ? `${f.relation_type} ${f.relation_name}` : '',
    address1: f.address1, address2: f.address2, pan: f.pan, email: f.email, phone: f.phone,
    member_name: f.name, member_place: ag.member_place,
    member_date: ag.member_signed_at ? istDateTime(ag.member_signed_at) : '',
    ticket_chosen: TICKETS[f.ticket] || '',
    _choices: { residence: f.residence, ticket: f.ticket },
  };
  if (opts.withCompany && ag.company_signed_at) {
    const p = istParts(ag.company_signed_at);
    Object.assign(out, {
      date_day: ordinal(p.day), date_month: p.month, date_year: String(p.year).slice(2),
      company_date: istDateTime(ag.company_signed_at), company_place: ag.company_place,
    });
  }
  return out;
}

// ------------------------------------------------------------------ PDF
async function buildPdf(ag, { withCompany = false, certificate = false } = {}) {
  const tpl = db.prepare('SELECT * FROM agreement_templates WHERE id = ?').get(ag.template_id);
  if (!tpl) throw new Error('Template missing');
  const pdf = await PDFDocument.load(fs.readFileSync(filePath(tpl.stored_name)));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.06, 0.13, 0.36);          // dark blue, like a pen
  const pages = pdf.getPages();
  const vals = values(ag, { withCompany });
  const spec = KINDS[ag.kind];

  for (const fd of spec.fields) {
    const page = pages[fd.page - 1];
    if (!page) continue;
    const H = page.getHeight();
    if (fd.type === 'signature') {
      const file = fd.src === 'company' ? (withCompany ? ag.company_sig : null) : ag.member_sig;
      if (!file || !fs.existsSync(filePath(file))) continue;
      const img = await pdf.embedPng(fs.readFileSync(filePath(file)));
      const scale = Math.min(fd.w / img.width, fd.h / img.height);
      const w = img.width * scale, h = img.height * scale;
      page.drawImage(img, { x: fd.x, y: H - fd.line, width: w, height: h });
      continue;
    }
    if (fd.type === 'strike' || fd.type === 'tick') {
      const [k, want] = fd.when;
      if (vals._choices[k] !== want) continue;
      if (fd.type === 'strike') page.drawLine({ start: { x: fd.x - 1, y: H - fd.line }, end: { x: fd.x + fd.w + 1, y: H - fd.line }, thickness: 1.3, color: ink });
      else {
        const x = fd.x, y = H - fd.line;
        page.drawLine({ start: { x: x + 1.5, y: y + 6 }, end: { x: x + 4.2, y: y + 2.6 }, thickness: 1.8, color: ink });
        page.drawLine({ start: { x: x + 4.2, y: y + 2.6 }, end: { x: x + 10, y: y + 11 }, thickness: 1.8, color: ink });
      }
      continue;
    }
    if (fd.src === 'company' && !withCompany) continue;
    const text = pdfSafe(vals[fd.key]);
    if (!text) continue;
    let size = fd.size || 10;
    while (size > 6 && font.widthOfTextAtSize(text, size) > fd.w - 4) size -= 0.5;
    const tw = font.widthOfTextAtSize(text, size);
    const x = fd.align === 'center' ? fd.x + (fd.w - tw) / 2 : fd.x + 2;
    page.drawText(text, { x, y: H - fd.line + 3.4, size, font, color: ink });
  }

  if (certificate) {
    const total = pages.length + 1;
    pages.forEach((page, i) => {
      page.drawText(pdfSafe(`Ref ${ag.ref}  ·  Electronically executed via VINC Global (vinc-global.com)  ·  Page ${i + 1} of ${total}`),
        { x: 36, y: 12, size: 6.5, font, color: rgb(0.45, 0.38, 0.32) });
    });
    await addCertificate(pdf, ag, { font, bold, total });
  }
  return Buffer.from(await pdf.save());
}

async function addCertificate(pdf, ag, { font, bold, total }) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ag.user_id) || {};
  const tpl = db.prepare('SELECT * FROM agreement_templates WHERE id = ?').get(ag.template_id) || {};
  const events = db.prepare('SELECT * FROM agreement_events WHERE agreement_id = ? ORDER BY at, id').all(ag.id);
  const f = typeof ag.fields === 'string' ? JSON.parse(ag.fields) : ag.fields || {};
  const geo = ag.member_geo ? JSON.parse(ag.member_geo) : null;
  const W = 595.2, H = 841.92, M = 44;
  let page = pdf.addPage([W, H]);
  let y = H - M;
  const amber = rgb(0.6, 0.36, 0.04), inkc = rgb(0.17, 0.1, 0.06), muted = rgb(0.43, 0.33, 0.26), line = rgb(0.86, 0.8, 0.68);
  const newPage = () => { page = pdf.addPage([W, H]); y = H - M; };
  const ensure = (need) => { if (y - need < M + 20) newPage(); };
  const text = (s, { x = M, size = 9.5, f = font, color = inkc } = {}) => page.drawText(pdfSafe(s), { x, y, size, font: f, color });
  const wrap = (s, width, size, f = font) => {
    const words = pdfSafe(s).split(' '); const lines = []; let cur = '';
    for (const w of words) { const t = cur ? cur + ' ' + w : w; if (f.widthOfTextAtSize(t, size) > width && cur) { lines.push(cur); cur = w; } else cur = t; }
    if (cur) lines.push(cur);
    return lines;
  };
  const row = (k, v, x = M, colW = 250) => {
    const lines = wrap(v || '—', colW - 110, 9);
    ensure(14 * lines.length);
    page.drawText(pdfSafe(k), { x, y, size: 7.5, font: bold, color: muted });
    lines.forEach((l, i) => page.drawText(l, { x: x + 108, y: y - i * 12, size: 9, font, color: inkc }));
    y -= 12 * lines.length + 4;
  };
  const rule = () => { page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: line }); y -= 14; };

  text('VINC GLOBAL', { size: 9, f: bold, color: amber }); y -= 22;
  text('Electronic signature certificate', { size: 20, f: bold }); y -= 18;
  text(`${KINDS[ag.kind].title}  ·  Ref ${ag.ref}  ·  Page ${total} of ${total}`, { size: 9.5, color: muted }); y -= 18;
  rule();
  row('STATUS', `Executed on ${istDateTime(ag.company_signed_at)} (${utcStamp(ag.company_signed_at)})`);
  row('DOCUMENT', `${tpl.original_name || KINDS[ag.kind].title}, ${KINDS[ag.kind].pages} pages`);
  row('TEMPLATE SHA-256', tpl.sha256 || '');
  y -= 4; rule();

  const sigBlock = async (title, rows, sigFile) => {
    ensure(150);
    text(title, { size: 11, f: bold }); y -= 18;
    const top = y;
    rows.forEach(([k, v]) => row(k, v, M, 330));
    if (sigFile && fs.existsSync(filePath(sigFile))) {
      const img = await pdf.embedPng(fs.readFileSync(filePath(sigFile)));
      const s = Math.min(150 / img.width, 54 / img.height);
      page.drawRectangle({ x: W - M - 166, y: top - 70, width: 166, height: 76, borderColor: line, borderWidth: 0.8 });
      page.drawImage(img, { x: W - M - 158, y: top - 62, width: img.width * s, height: img.height * s });
      page.drawText('Signature', { x: W - M - 158, y: top - 80, size: 7, font, color: muted });
      if (y > top - 92) y = top - 92;
    }
    y -= 6; rule();
  };
  await sigBlock(`Signed by the ${user.role === 'investor' ? 'Investor' : 'Advisor'}`, [
    ['NAME', f.name], ['VINC ID', user.uid], ['EMAIL', f.email], ['PHONE', f.phone], ['PAN', f.pan],
    ['SIGNED AT', `${istDateTime(ag.member_signed_at)} (${utcStamp(ag.member_signed_at)})`],
    ['PLACE (ENTERED)', ag.member_place],
    ['LOCATION (DEVICE)', geo ? `${geo.lat.toFixed(5)}, ${geo.lon.toFixed(5)} (accuracy about ${Math.round(geo.acc || 0)} m)` : 'Not shared'],
    ['IP ADDRESS', ag.member_ip], ['DEVICE', String(ag.member_ua || '').slice(0, 140)],
  ], ag.member_sig);
  await sigBlock('Signed for VINC DEEPTECH PRIVATE LIMITED', [
    ['NAME', ag.company_signer], ['SIGNED AT', `${istDateTime(ag.company_signed_at)} (${utcStamp(ag.company_signed_at)})`],
    ['PLACE', ag.company_place],
    ['METHOD', ag.company_method === 'auto' ? "Company's saved signature, applied automatically as authorised by the admin" : 'Countersigned by the admin in VINC Global'],
    ['IP ADDRESS', ag.company_ip || '—'],
  ], ag.company_sig);

  ensure(60);
  text('Consent given by the signer', { size: 11, f: bold }); y -= 16;
  for (const l of wrap(CONSENT, W - 2 * M, 9)) { ensure(12); text(l, { size: 9, color: muted }); y -= 12; }
  y -= 6; rule();
  ensure(40);
  text('Audit trail', { size: 11, f: bold }); y -= 16;
  for (const e of events) {
    ensure(14);
    text(istDateTime(e.at), { size: 8.5, color: muted });
    text(`${e.actor}: ${e.action}${e.detail ? ' (' + e.detail + ')' : ''}${e.ip ? '  ·  IP ' + e.ip : ''}`.slice(0, 120), { x: M + 140, size: 8.5 });
    y -= 13;
  }
  y -= 8;
  ensure(30);
  for (const l of wrap('The SHA-256 fingerprint of this executed file is recorded in VINC Global, so any later change to the file can be detected.', W - 2 * M, 8)) { text(l, { size: 8, color: muted }); y -= 11; }
}

// ------------------------------------------------------------------ records
function logEvent(agreementId, actor, action, detail, ip) {
  db.prepare('INSERT INTO agreement_events (agreement_id, at, actor, action, detail, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .run(agreementId, Date.now(), actor, action, detail || null, ip || null);
}

function activeTemplate(kind) {
  return db.prepare('SELECT * FROM agreement_templates WHERE kind = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(kind) || null;
}

function openAgreement(userId, kind) {
  return db.prepare("SELECT * FROM agreements WHERE user_id = ? AND kind = ? AND status != 'void' ORDER BY id DESC LIMIT 1").get(userId, kind) || null;
}

/** Create the agreement a member needs for their role, if the template is uploaded and none is open. */
function ensureFor(user, kind = kindForRole(user.role), actor = 'System') {
  const existing = openAgreement(user.id, kind);
  if (existing) return { agreement: existing, created: false };
  const tpl = activeTemplate(kind);
  if (!tpl) return { agreement: null, created: false };
  const info = db.prepare("INSERT INTO agreements (ref, user_id, kind, template_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
    .run(newRef(), user.id, kind, tpl.id, Date.now(), Date.now());
  logEvent(info.lastInsertRowid, actor, 'Agreement prepared for signing', KINDS[kind].title);
  return { agreement: db.prepare('SELECT * FROM agreements WHERE id = ?').get(info.lastInsertRowid), created: true };
}

function companySettings() {
  const s = getSettings();
  return {
    signer_name: s.company_signer_name || 'Rachit Arora',
    signer_title: s.company_signer_title || 'Founder & CEO',
    place: s.company_sign_place || 'Bengaluru',
    auto: s.auto_countersign === '1',
    signature: s.company_sig_file && fs.existsSync(filePath(s.company_sig_file)) ? s.company_sig_file : null,
    signature_set_at: Number(s.company_sig_set_at) || null,
  };
}

/** The company signs; the PDF is built and stored; the member may become permanent. */
async function execute(ag, { method, place, sigFile, ip, actor }) {
  const cs = companySettings();
  const now = Date.now();
  db.prepare(`UPDATE agreements SET company_sig = ?, company_signed_at = ?, company_place = ?, company_signer = ?, company_method = ?, company_ip = ?, updated_at = ? WHERE id = ?`)
    .run(sigFile, now, place || cs.place, `${cs.signer_name}, ${cs.signer_title}`, method, ip || null, now, ag.id);
  logEvent(ag.id, actor, method === 'auto' ? 'Countersigned automatically with the saved company signature' : 'Countersigned', `place: ${place || cs.place}`, ip);
  const fresh = db.prepare('SELECT * FROM agreements WHERE id = ?').get(ag.id);
  // Record execution before building so it appears in the audit trail.
  const execAt = Date.now();
  db.prepare('INSERT INTO agreement_events (agreement_id, at, actor, action, detail, ip) VALUES (?, ?, ?, ?, ?, ?)').run(ag.id, execAt, 'System', 'Agreement executed', null, null);
  const bytes = await buildPdf(fresh, { withCompany: true, certificate: true });
  const name = saveFile(bytes, '.pdf');
  db.prepare("UPDATE agreements SET status = 'executed', executed_name = ?, executed_sha256 = ?, updated_at = ? WHERE id = ?")
    .run(name, sha256(bytes), Date.now(), ag.id);
  return db.prepare('SELECT * FROM agreements WHERE id = ?').get(ag.id);
}

/** True when every open agreement for this member is executed (and there is at least one). */
function allExecuted(userId) {
  const rows = db.prepare("SELECT status FROM agreements WHERE user_id = ? AND status != 'void'").all(userId);
  return rows.length > 0 && rows.every((r) => r.status === 'executed');
}

function publicAgreement(ag, { admin = false } = {}) {
  if (!ag) return null;
  const spec = KINDS[ag.kind];
  const out = {
    id: ag.id, ref: ag.ref, kind: ag.kind, title: spec.title, status: ag.status,
    fields: ag.fields ? JSON.parse(ag.fields) : null,
    member_signed_at: ag.member_signed_at, member_place: ag.member_place,
    company_signed_at: ag.company_signed_at, company_place: ag.company_place, company_signer: ag.company_signer, company_method: ag.company_method,
    executed: ag.status === 'executed', executed_sha256: ag.executed_sha256, void_reason: ag.void_reason, created_at: ag.created_at,
  };
  if (admin) Object.assign(out, { member_ip: ag.member_ip, member_ua: ag.member_ua, member_geo: ag.member_geo ? JSON.parse(ag.member_geo) : null, company_ip: ag.company_ip, user_id: ag.user_id });
  return out;
}

module.exports = {
  KINDS, TICKETS, CONSENT, kindForRole, validateFields, decodeSignature, saveFile, filePath, sha256, SAFE,
  buildPdf, logEvent, activeTemplate, openAgreement, ensureFor, companySettings, execute, allExecuted, publicAgreement, istDateTime,
};
