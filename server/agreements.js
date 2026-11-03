'use strict';
// Onboarding agreements. Advisors sign the Advisory Agreement and the Investor Term Sheet; investors sign the
// Term Sheet. The admin uploads the PDFs once (they are not kept in the repository) and can add any other
// agreement: its underscore blanks are found automatically and the admin says what each one is for.
// Members fill the blanks and sign; the company countersigns (by hand, or automatically with its saved
// signature). The executed PDF has the blanks filled, both signatures, a reference on every page and a
// signature certificate page. When all required agreements are executed, the member becomes permanent.
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

// Which built-in documents each role must sign to become permanent.
const ROLE_KINDS = { advisor: ['advisory', 'term_sheet'], investor: ['term_sheet'] };
const kindsForRole = (role) => ROLE_KINDS[role] || ROLE_KINDS.advisor;
const TICKETS = { 1: 'Option 1: Rs. 6,00,000', 2: 'Option 2: Rs. 12,00,000' };
const CONSENT = 'I have read this document in full. I agree to fill it in and sign it electronically, and I accept that my electronic signature is as binding as a handwritten one. I understand that VINC Global records the date and time, the place I enter, my IP address and device, and my location if I choose to share it.';

// Custom agreements: every underscore blank found in the PDF gets one of these modes, chosen by the admin.
const MODES = {
  member: 'Member fills in (required)',
  optional: 'Member fills in (optional)',
  member_name: "Member's name (automatic)",
  member_signature: "Member's signature",
  member_date: "Member's signing date and time",
  member_place: "Member's place of signing",
  company: 'Fixed text (you type it once)',
  company_signature: 'Company signature',
  company_date: 'Company signing date and time',
  company_place: 'Company place of signing',
  date: 'Agreement date (filled on execution)',
  skip: 'Leave blank',
};

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
const istDate = (t) => { const p = istParts(t); return `${p.day} ${p.month} ${p.year}`; };
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

// ------------------------------------------------------------------ templates and their fields
const templateById = (id) => (id ? db.prepare('SELECT * FROM agreement_templates WHERE id = ?').get(id) : null);
const templateOf = (ag) => templateById(ag.template_id);
function titleOf(agOrTpl) {
  if (agOrTpl.kind !== 'custom') return KINDS[agOrTpl.kind].title;
  const t = agOrTpl.ref === undefined ? agOrTpl : templateOf(agOrTpl);   // agreements have a ref, templates do not
  return (t && t.title) || 'Agreement';
}

/** Find every run of 3+ underscores in a PDF, with the nearby text as a hint of what it is for. */
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

/** A first guess at each blank's purpose; the admin confirms or changes it. */
function suggestMode(hint) {
  const h = String(hint || '').toLowerCase();
  if (/signature|signed by/.test(h)) return 'skip';
  if (/^date|date:$|dated/.test(h)) return 'skip';
  if (/^place/.test(h)) return 'skip';
  return 'member';
}

/** The fields a document has: measured ones for the two standard documents, configured blanks for custom ones. */
function fieldsOf(agOrTpl) {
  if (agOrTpl.kind !== 'custom') return KINDS[agOrTpl.kind].fields;
  const t = agOrTpl.ref === undefined ? agOrTpl : templateOf(agOrTpl);
  const blanks = t && t.fields ? JSON.parse(t.fields) : [];
  const out = [];
  for (const b of blanks) {
    const mode = MODES[b.mode] ? b.mode : 'skip';
    if (mode === 'skip') continue;
    const base = { key: `b${b.id}`, page: b.page, x: b.x, w: b.w, line: b.line, label: b.label || b.hint || `Blank ${b.id}`, mode };
    if (mode === 'member' || mode === 'optional') out.push({ ...base, src: 'member', optional: mode === 'optional' });
    else if (mode === 'member_signature') out.push({ ...base, key: `sig${b.id}`, src: 'member', type: 'signature', h: 30, sigOf: 'member' });
    else if (mode === 'company_signature') out.push({ ...base, key: `sig${b.id}`, src: 'company', type: 'signature', h: 30, sigOf: 'company' });
    else if (mode === 'member_place') out.push({ ...base, src: 'member', placeOf: 'member' });
    else if (mode === 'company' ) out.push({ ...base, src: 'fixed', value: b.value || '' });
    else if (mode === 'company_date' || mode === 'company_place') out.push({ ...base, src: 'company' });
    else out.push({ ...base, src: 'auto' });       // member_name, member_date, date
  }
  return out;
}

// ------------------------------------------------------------------ member input
function validateFields(ag, input) {
  const v = (k, max = 80) => String((input && input[k]) || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const errors = [];
  if (ag.kind === 'custom') {
    const f = {};
    for (const fd of fieldsOf(ag).filter((x) => x.src === 'member' && !x.type && !x.placeOf)) {
      f[fd.key] = v(fd.key, 120);
      if (!f[fd.key] && !fd.optional) errors.push(`Please fill in “${fd.label}”.`);
    }
    for (const val of Object.values(f)) if (!SAFE.test(val)) { errors.push('Please use English letters only.'); break; }
    return { fields: f, errors };
  }
  const f = {
    name: v('name'), relation_type: v('relation_type', 3), relation_name: v('relation_name'),
    address1: v('address1', 60), address2: v('address2', 60), pan: v('pan', 10).toUpperCase(),
    email: v('email', 120), phone: v('phone', 20),
  };
  if (ag.kind === 'term_sheet') { f.residence = v('residence', 12); f.ticket = v('ticket', 1); }
  if (f.name.length < 2) errors.push('Enter your full name.');
  if (!['S/o', 'D/o', 'W/o'].includes(f.relation_type)) errors.push('Choose S/o, D/o or W/o.');
  if (f.relation_name.length < 2) errors.push("Enter your father's or spouse's name.");
  if (f.address1.length < 4) errors.push('Enter your address.');
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(f.pan)) errors.push('Enter a valid PAN, like ABCDE1234F.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) errors.push('Enter a valid email address.');
  if (!/^[+0-9][0-9 ()-]{6,19}$/.test(f.phone)) errors.push('Enter a valid phone number.');
  if (ag.kind === 'term_sheet') {
    if (!['resident', 'nonresident'].includes(f.residence)) errors.push('Choose your residential status.');
    if (!['1', '2'].includes(f.ticket)) errors.push('Choose a ticket size.');
  }
  for (const [k, val] of Object.entries(f)) if (!SAFE.test(val)) { errors.push(`Please use English letters only (${k.replace('_', ' ')}).`); break; }
  return { fields: f, errors };
}

/** Text for each field on the document. */
function values(ag, opts = {}) {
  const f = ag.fields ? (typeof ag.fields === 'string' ? JSON.parse(ag.fields) : ag.fields) : {};
  const user = db.prepare('SELECT name FROM users WHERE id = ?').get(ag.user_id) || {};
  const memberName = f.name || user.name || '';
  const out = {
    ...f,
    name: f.name, relation: f.relation_type && f.relation_name ? `${f.relation_type} ${f.relation_name}` : '',
    member_name: memberName, member_place: ag.member_place,
    member_date: ag.member_signed_at ? istDateTime(ag.member_signed_at) : '',
    ticket_chosen: TICKETS[f.ticket] || '',
    _choices: { residence: f.residence, ticket: f.ticket },
  };
  const company = opts.withCompany && ag.company_signed_at;
  if (company) {
    const p = istParts(ag.company_signed_at);
    Object.assign(out, {
      date_day: ordinal(p.day), date_month: p.month, date_year: String(p.year).slice(2),
      company_date: istDateTime(ag.company_signed_at), company_place: ag.company_place,
    });
  }
  if (ag.kind === 'custom') {
    for (const fd of fieldsOf(ag)) {
      if (fd.src === 'fixed') out[fd.key] = fd.value;
      else if (fd.mode === 'member_name') out[fd.key] = memberName;
      else if (fd.mode === 'member_date') out[fd.key] = out.member_date;
      else if (fd.mode === 'member_place') out[fd.key] = ag.member_place;
      else if (fd.mode === 'company_date') out[fd.key] = company ? out.company_date : '';
      else if (fd.mode === 'company_place') out[fd.key] = company ? ag.company_place : '';
      else if (fd.mode === 'date') out[fd.key] = company ? istDate(ag.company_signed_at) : '';
    }
  }
  return out;
}

// ------------------------------------------------------------------ PDF
async function buildPdf(ag, { withCompany = false, certificate = false } = {}) {
  const tpl = templateOf(ag);
  if (!tpl) throw new Error('Template missing');
  const pdf = await PDFDocument.load(fs.readFileSync(filePath(tpl.stored_name)));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.06, 0.13, 0.36);          // dark blue, like a pen
  const pages = pdf.getPages();
  const vals = values(ag, { withCompany });

  for (const fd of fieldsOf(ag)) {
    const page = pages[fd.page - 1];
    if (!page) continue;
    const H = page.getHeight();
    if (fd.type === 'signature') {
      const isCompany = fd.src === 'company';
      const file = isCompany ? (withCompany ? ag.company_sig : null) : ag.member_sig;
      if (!file || !fs.existsSync(filePath(file))) continue;
      const img = await pdf.embedPng(fs.readFileSync(filePath(file)));
      const scale = Math.min(fd.w / img.width, (fd.h || 30) / img.height);
      page.drawImage(img, { x: fd.x, y: H - fd.line, width: img.width * scale, height: img.height * scale });
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

  // Custom documents get a signature page after their own pages.
  if (ag.kind === 'custom') await addSignaturePage(pdf, ag, { font, bold, withCompany, vals });

  if (certificate) {
    const all = pdf.getPages();
    const total = all.length + 1;
    all.forEach((page, i) => {
      page.drawText(pdfSafe(`Ref ${ag.ref}  ·  Electronically executed via VINC Global (vinc-global.com)  ·  Page ${i + 1} of ${total}`),
        { x: 36, y: 12, size: 6.5, font, color: rgb(0.45, 0.38, 0.32) });
    });
    await addCertificate(pdf, ag, { font, bold, total });
  }
  return Buffer.from(await pdf.save());
}

async function addSignaturePage(pdf, ag, { font, bold, withCompany, vals }) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ag.user_id) || {};
  const cs = companySettings();
  const W = 595.2, H = 841.92, M = 56;
  const page = pdf.addPage([W, H]);
  const inkc = rgb(0.17, 0.1, 0.06), muted = rgb(0.43, 0.33, 0.26), amber = rgb(0.6, 0.36, 0.04), line = rgb(0.86, 0.8, 0.68), ink = rgb(0.06, 0.13, 0.36);
  let y = H - M - 10;
  page.drawText('SIGNATURE PAGE', { x: M, y, size: 9, font: bold, color: amber }); y -= 26;
  page.drawText(pdfSafe(titleOf(ag)), { x: M, y, size: 18, font: bold, color: inkc }); y -= 20;
  page.drawText(pdfSafe(`Ref ${ag.ref}. The parties have signed this document electronically as set out below.`), { x: M, y, size: 9.5, font, color: muted });
  y -= 40;
  const colW = (W - 2 * M - 24) / 2;
  const block = async (x, heading, sigFile, rows) => {
    let yy = y;
    page.drawRectangle({ x, y: yy - 250, width: colW, height: 262, borderColor: line, borderWidth: 1 });
    page.drawText(pdfSafe(heading), { x: x + 14, y: yy - 8, size: 10.5, font: bold, color: amber });
    yy -= 34;
    page.drawText('Signature:', { x: x + 14, y: yy - 30, size: 9.5, font, color: inkc });
    if (sigFile && fs.existsSync(filePath(sigFile))) {
      const img = await pdf.embedPng(fs.readFileSync(filePath(sigFile)));
      const s = Math.min((colW - 90) / img.width, 46 / img.height);
      page.drawImage(img, { x: x + 72, y: yy - 34, width: img.width * s, height: img.height * s });
    }
    page.drawLine({ start: { x: x + 14, y: yy - 38 }, end: { x: x + colW - 14, y: yy - 38 }, thickness: 0.8, color: line });
    yy -= 66;
    for (const [k, v] of rows) {
      page.drawText(pdfSafe(k), { x: x + 14, y: yy, size: 8, font: bold, color: muted });
      page.drawText(pdfSafe(v || ''), { x: x + 14, y: yy - 13, size: 10, font, color: v ? ink : muted });
      yy -= 32;
    }
  };
  await block(M, 'For VINC DEEPTECH PRIVATE LIMITED', withCompany ? ag.company_sig : null, [
    ['NAME', cs.signer_name], ['DESIGNATION', cs.signer_title],
    ['DATE AND TIME', withCompany && ag.company_signed_at ? istDateTime(ag.company_signed_at) : ''],
    ['PLACE', withCompany ? ag.company_place : ''],
  ]);
  await block(M + colW + 24, user.role === 'investor' ? 'THE INVESTOR' : 'THE ADVISOR', ag.member_sig, [
    ['NAME', vals.member_name], ['VINC ID', user.uid],
    ['DATE AND TIME', ag.member_signed_at ? istDateTime(ag.member_signed_at) : ''],
    ['PLACE', ag.member_place || ''],
  ]);
}

async function addCertificate(pdf, ag, { font, bold, total }) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ag.user_id) || {};
  const tpl = templateOf(ag) || {};
  const events = db.prepare('SELECT * FROM agreement_events WHERE agreement_id = ? ORDER BY at, id').all(ag.id);
  const f = typeof ag.fields === 'string' ? JSON.parse(ag.fields) : ag.fields || {};
  const geo = ag.member_geo ? JSON.parse(ag.member_geo) : null;
  const W = 595.2, H = 841.92, M = 44;
  let page = pdf.addPage([W, H]);
  let y = H - M;
  const amber = rgb(0.6, 0.36, 0.04), inkc = rgb(0.17, 0.1, 0.06), muted = rgb(0.43, 0.33, 0.26), line = rgb(0.86, 0.8, 0.68);
  const newPage = () => { page = pdf.addPage([W, H]); y = H - M; };
  const ensure = (need) => { if (y - need < M + 20) newPage(); };
  const text = (s, { x = M, size = 9.5, f: fo = font, color = inkc } = {}) => page.drawText(pdfSafe(s), { x, y, size, font: fo, color });
  const wrap = (s, width, size, fo = font) => {
    const words = pdfSafe(s).split(' '); const lines = []; let cur = '';
    for (const w of words) { const t = cur ? cur + ' ' + w : w; if (fo.widthOfTextAtSize(t, size) > width && cur) { lines.push(cur); cur = w; } else cur = t; }
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
  text(`${titleOf(ag)}  ·  Ref ${ag.ref}  ·  Page ${total} of ${total}`, { size: 9.5, color: muted }); y -= 18;
  rule();
  row('STATUS', `Executed on ${istDateTime(ag.company_signed_at)} (${utcStamp(ag.company_signed_at)})`);
  row('DOCUMENT', `${tpl.original_name || titleOf(ag)}, ${tpl.pages || '?'} pages`);
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
  const memberName = f.name || user.name;
  await sigBlock(`Signed by the ${user.role === 'investor' ? 'Investor' : 'Advisor'}`, [
    ['NAME', memberName], ['VINC ID', user.uid], ['EMAIL', f.email || user.email], ['PHONE', f.phone || user.phone], ...(f.pan ? [['PAN', f.pan]] : []),
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

function openAgreement(userId, kind, templateId) {
  if (kind === 'custom') return db.prepare("SELECT * FROM agreements WHERE user_id = ? AND template_id = ? AND status != 'void' ORDER BY id DESC LIMIT 1").get(userId, templateId) || null;
  return db.prepare("SELECT * FROM agreements WHERE user_id = ? AND kind = ? AND status != 'void' ORDER BY id DESC LIMIT 1").get(userId, kind) || null;
}

function createAgreement(user, tpl, actor) {
  const kind = tpl.kind;
  const mandatory = kind === 'custom' ? (tpl.required ? 1 : 0) : 1;
  const info = db.prepare("INSERT INTO agreements (ref, user_id, kind, template_id, mandatory, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)")
    .run(newRef(), user.id, kind, tpl.id, mandatory, Date.now(), Date.now());
  logEvent(info.lastInsertRowid, actor, 'Agreement prepared for signing', titleOf(tpl));
  return db.prepare('SELECT * FROM agreements WHERE id = ?').get(info.lastInsertRowid);
}

/** Make sure a member has an open agreement for a standard document (kind) or a custom one (template). */
function ensureFor(user, kindOrTemplate, actor = 'System') {
  const tpl = typeof kindOrTemplate === 'object' ? kindOrTemplate : activeTemplate(kindOrTemplate);
  if (!tpl) return { agreement: null, created: false };
  const existing = openAgreement(user.id, tpl.kind, tpl.id);
  if (existing) return { agreement: existing, created: false };
  return { agreement: createAgreement(user, tpl, actor), created: true };
}

/** All standard documents the member's role requires (those whose PDF has been uploaded). */
function ensureRole(user, actor = 'System') {
  const created = [];
  for (const kind of kindsForRole(user.role)) {
    const r = ensureFor(user, kind, actor);
    if (r.created) created.push(r.agreement);
  }
  return created;
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

/** The company signs; the PDF is built and stored. */
async function execute(ag, { method, place, sigFile, ip, actor }) {
  const cs = companySettings();
  const now = Date.now();
  db.prepare(`UPDATE agreements SET company_sig = ?, company_signed_at = ?, company_place = ?, company_signer = ?, company_method = ?, company_ip = ?, updated_at = ? WHERE id = ?`)
    .run(sigFile, now, place || cs.place, `${cs.signer_name}, ${cs.signer_title}`, method, ip || null, now, ag.id);
  logEvent(ag.id, actor, method === 'auto' ? 'Countersigned automatically with the saved company signature' : 'Countersigned', `place: ${place || cs.place}`, ip);
  logEvent(ag.id, 'System', 'Agreement executed', null, null);
  const fresh = db.prepare('SELECT * FROM agreements WHERE id = ?').get(ag.id);
  const bytes = await buildPdf(fresh, { withCompany: true, certificate: true });
  const name = saveFile(bytes, '.pdf');
  db.prepare("UPDATE agreements SET status = 'executed', executed_name = ?, executed_sha256 = ?, updated_at = ? WHERE id = ?")
    .run(name, sha256(bytes), Date.now(), ag.id);
  return db.prepare('SELECT * FROM agreements WHERE id = ?').get(ag.id);
}

/**
 * True when everything the member must sign is executed: every standard document their role requires
 * (whose PDF is uploaded) and every custom agreement sent to them marked as required.
 */
function requiredDone(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return false;
  const rows = db.prepare("SELECT kind, status, mandatory FROM agreements WHERE user_id = ? AND status != 'void'").all(userId);
  const required = rows.filter((r) => r.mandatory);
  if (!required.length) return false;
  for (const kind of kindsForRole(user.role)) {
    if (activeTemplate(kind) && !rows.some((r) => r.kind === kind && r.status === 'executed')) return false;
  }
  return required.every((r) => r.status === 'executed');
}

function publicAgreement(ag, { admin = false } = {}) {
  if (!ag) return null;
  const out = {
    id: ag.id, ref: ag.ref, kind: ag.kind, template_id: ag.template_id, title: titleOf(ag), status: ag.status, mandatory: !!ag.mandatory,
    fields: ag.fields ? JSON.parse(ag.fields) : null,
    member_signed_at: ag.member_signed_at, member_place: ag.member_place,
    company_signed_at: ag.company_signed_at, company_place: ag.company_place, company_signer: ag.company_signer, company_method: ag.company_method,
    executed: ag.status === 'executed', executed_sha256: ag.executed_sha256, void_reason: ag.void_reason, created_at: ag.created_at,
  };
  if (admin) Object.assign(out, { member_ip: ag.member_ip, member_ua: ag.member_ua, member_geo: ag.member_geo ? JSON.parse(ag.member_geo) : null, company_ip: ag.company_ip, user_id: ag.user_id });
  return out;
}

module.exports = {
  KINDS, MODES, TICKETS, CONSENT, kindsForRole, validateFields, decodeSignature, saveFile, filePath, sha256, SAFE,
  detectBlanks, suggestMode, fieldsOf, titleOf, templateById,
  buildPdf, logEvent, activeTemplate, openAgreement, ensureFor, ensureRole, companySettings, execute, requiredDone, publicAgreement, istDateTime,
};
