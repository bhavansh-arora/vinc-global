'use strict';
// Replaced documents get their blanks found and set up; the Shareholder Loan Agreement and the Convertible Debt
// Note Agreement join the Investor Term Sheet as "sign any one"; advisors also sign the Advisory Agreement.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'vinc-global-test-'));
process.env.DATA_DIR = DATA;
process.env.MAIL_TRANSPORT = 'json';
const app = require('../server/index.js');
const { db } = require('../server/db.js');
const AGM = require('../server/agreements.js');

let server, base;
before(async () => { server = app.listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async (method, url, body, form) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
}
/** A one-page agreement with underscore blanks, like a typical Word export. */
async function agreementPdf(title) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.2, 841.92]);
  const line = (t, y) => page.drawText(t, { x: 60, y, size: 11, font });
  line(title, 780);
  line('Name of the Lender: ______________________', 720);
  line('PAN: ______________', 690);
  line('Amount (Rs.): ______________', 660);
  line('Signature: ____________________', 200);
  line('Place: ______________', 170);
  return Buffer.from(await doc.save());
}
function pngDataUrl() {
  const crc = (buf) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let x = 0xffffffff; for (const b of buf) x = t[(x ^ b) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const w = 60, h = 20, raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; if (Math.abs(y - 10 - Math.round(6 * Math.sin(x / 5))) < 2) { raw[o] = 16; raw[o + 1] = 34; raw[o + 2] = 92; raw[o + 3] = 255; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const upload = (c, kind, buf) => { const fd = new FormData(); fd.append('file', new Blob([buf], { type: 'application/pdf' }), `${kind}.pdf`); return c('POST', `/api/admin/agreements/templates/${kind}`, undefined, fd); };

/** Upload a document, then confirm its blanks: member fills the first ones, signature/place as found. */
async function uploadAndSetUp(admin, kind, buf) {
  const up = await upload(admin, kind, buf);
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.needs_setup, true);
  assert.equal(up.body.ready, false);
  const t = await admin('GET', `/api/admin/agreements/custom/${up.body.id}`);
  assert.equal(t.status, 200);
  assert.equal(t.body.standard, true);
  const modes = { 'Name of the Lender': 'member_name', PAN: 'member', 'Amount (Rs.)': 'member', Signature: 'member_signature', Place: 'member_place' };
  const blanks = t.body.blanks_list.map((b) => ({ id: b.id, mode: modes[b.label] || 'skip', label: b.label, value: '' }));
  const saved = await admin('PUT', `/api/admin/agreements/custom/${up.body.id}`, { blanks });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.ready, true);
  return up.body.id;
}

async function member(admin, role, name) {
  const gen = await admin('POST', '/api/admin/users', { role, name, email: `${name.replace(/\W/g, '').toLowerCase()}@example.com`, password: 'abc12345', access: 'temporary' });
  assert.equal(gen.status, 200, JSON.stringify(gen.body));
  const m = client();
  assert.equal((await m('POST', '/api/auth/login', { uid: gen.body.uid, password: 'abc12345' })).status, 200);
  return { m, user: gen.body };
}

const sign = (m, id, fields = {}) => m('POST', `/api/member/agreements/${id}/sign`, { fields, place: 'Pune', signature: pngDataUrl(), consent: true });

test('a replaced document gets its blanks found and waits for the admin to set them up', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { uid: 'admin', password: 'Vinc@2026' });
  // The measured Advisory Agreement (a stand-in) is in place and an advisor has it waiting
  const original = await PDFDocument.create(); for (let i = 0; i < 6; i++) original.addPage([595.2, 841.92]);
  const origBuf = Buffer.from(await original.save());
  AGM.KINDS.advisory.sha256 = require('node:crypto').createHash('sha256').update(origBuf).digest('hex');
  assert.equal((await upload(admin, 'advisory', origBuf)).body.layout, 'measured');
  const { m, user } = await member(admin, 'advisor', 'Replace Advisor');
  const before = (await m('GET', '/api/member/agreements')).body.agreements.find((a) => a.kind === 'advisory');
  assert.ok(before && !before.updating);

  // A new version replaces it: blanks are found, the unsigned copy moves to it and waits for the set-up
  const up = await upload(admin, 'advisory', await agreementPdf('ADVISORY AGREEMENT (2026)'));
  assert.equal(up.body.needs_setup, true);
  assert.equal(up.body.layout, 'blanks');
  assert.equal(up.body.blanks, 5);
  const waiting = (await m('GET', '/api/member/agreements')).body.agreements.find((a) => a.kind === 'advisory');
  assert.equal(waiting.id, before.id);
  assert.equal(waiting.updating, true);
  assert.equal((await sign(m, waiting.id)).status, 409, 'cannot be signed until set up');
  // It cannot be sent until set up either
  assert.equal((await admin('POST', '/api/admin/agreements/send', { kind: 'advisory', user_ids: [user.id] })).status, 400);

  // The admin sets it up; the member fills the blanks and signs; the PDF has a signature page
  const t = await admin('GET', `/api/admin/agreements/custom/${up.body.id}`);
  const modes = { 'Name of the Lender': 'member_name', PAN: 'member', 'Amount (Rs.)': 'skip', Signature: 'member_signature', Place: 'member_place' };
  const put = await admin('PUT', `/api/admin/agreements/custom/${up.body.id}`, { blanks: t.body.blanks_list.map((b) => ({ id: b.id, mode: modes[b.label], label: b.label, value: '' })) });
  assert.equal(put.body.ready, true);
  const detail = await m('GET', `/api/member/agreements/${waiting.id}`);
  assert.equal(detail.body.spec.custom, true);
  const panKey = detail.body.spec.fields.find((f) => f.label === 'PAN').key;
  assert.equal((await sign(m, waiting.id, {})).status, 400, 'required blank enforced');
  const ok = await sign(m, waiting.id, { [panKey]: 'ABCDE1234F' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const pdf = await admin('GET', `/api/admin/agreements/${waiting.id}/pdf`);
  assert.equal((await PDFDocument.load(pdf.body)).getPageCount(), 2, 'its page plus the signature page');
});

test('an older replaced file without blanks waits for set-up, and its blanks are found when the admin opens it', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { uid: 'admin', password: 'Vinc@2026' });
  // As uploaded by the previous version: a different file, no blanks, marked ready
  const buf = await agreementPdf('INVESTOR TERM SHEET (revised)');
  const name = AGM.saveFile(buf, '.pdf');
  db.prepare('UPDATE agreement_templates SET active = 0 WHERE kind = ?').run('term_sheet');
  const id = db.prepare("INSERT INTO agreement_templates (kind, title, stored_name, original_name, sha256, pages, active, uploaded_at) VALUES ('term_sheet', 'Investor Term Sheet', ?, 'ts.pdf', ?, 1, 1, ?)")
    .run(name, AGM.sha256(buf), Date.now()).lastInsertRowid;
  const list = await admin('GET', '/api/admin/agreements');
  const ts = list.body.templates.find((t) => t.kind === 'term_sheet');
  assert.equal(ts.id, id);
  assert.equal(ts.layout, 'blanks');
  assert.equal(ts.ready, false);
  assert.equal(ts.blanks, 0, 'the Agreements page itself does not read the PDF');
  assert.equal(list.body.templates.length, 4, 'advisory, term sheet, shareholder loan, convertible note');
  const setup = await admin('GET', `/api/admin/agreements/custom/${id}`);
  assert.equal(setup.status, 200);
  assert.equal(setup.body.blanks_list.length, 5);
  assert.equal(setup.body.ready, false);
});

test('advisors sign the Advisory Agreement and one investment agreement; investors sign one', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { uid: 'admin', password: 'Vinc@2026' });
  await admin('PUT', '/api/admin/agreements/company', { signature: pngDataUrl(), auto: true });
  // Set up all three investment agreements (the term sheet from the previous test, and the two new ones)
  const ts = (await admin('GET', '/api/admin/agreements')).body.templates.find((t) => t.kind === 'term_sheet');
  const tsDetail = await admin('GET', `/api/admin/agreements/custom/${ts.id}`);
  await admin('PUT', `/api/admin/agreements/custom/${ts.id}`, { blanks: tsDetail.body.blanks_list.map((b) => ({ id: b.id, mode: 'skip' })) });
  await uploadAndSetUp(admin, 'shareholder_loan', await agreementPdf('SHAREHOLDER LOAN AGREEMENT'));
  await uploadAndSetUp(admin, 'convertible_note', await agreementPdf('CONVERTIBLE DEBT NOTE AGREEMENT'));

  // An advisor is offered the Advisory Agreement and all three investment agreements
  const { m: adv, user: advUser } = await member(admin, 'advisor', 'Choice Advisor');
  let list = (await adv('GET', '/api/member/agreements')).body;
  assert.deepEqual(list.agreements.map((a) => a.kind).sort(), ['advisory', 'convertible_note', 'shareholder_loan', 'term_sheet']);
  assert.equal(list.agreements.filter((a) => a.group === 'instrument').length, 3);
  const approveMail = await admin('POST', `/api/admin/users/${advUser.id}/approve`, { type: 'temporary' });
  assert.equal(approveMail.status, 200);

  // Signing the Shareholder Loan Agreement withdraws the other two choices
  const loan = list.agreements.find((a) => a.kind === 'shareholder_loan');
  const panKey = (await adv('GET', `/api/member/agreements/${loan.id}`)).body.spec.fields.find((f) => f.label === 'PAN').key;
  const amountKey = (await adv('GET', `/api/member/agreements/${loan.id}`)).body.spec.fields.find((f) => f.label === 'Amount (Rs.)').key;
  const r1 = await sign(adv, loan.id, { [panKey]: 'ABCDE1234F', [amountKey]: '5,00,000' });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.upgraded, false, 'the Advisory Agreement is still needed');
  list = (await adv('GET', '/api/member/agreements')).body;
  assert.deepEqual(list.agreements.map((a) => a.kind).sort(), ['advisory', 'shareholder_loan']);
  const tsVoid = db.prepare("SELECT status, void_reason FROM agreements WHERE user_id = ? AND kind = 'term_sheet'").get(advUser.id);
  assert.equal(tsVoid.status, 'void');
  assert.match(tsVoid.void_reason, /^Not needed: you chose the Shareholder Loan Agreement/);

  // The Advisory Agreement (measured stand-in from test 1 was replaced and set up there) completes it
  const advisory = list.agreements.find((a) => a.kind === 'advisory');
  const advFields = (await adv('GET', `/api/member/agreements/${advisory.id}`)).body.spec.fields;
  const fill = Object.fromEntries(advFields.filter((f) => f.src === 'member' && !f.type && !f.placeOf).map((f) => [f.key, 'ABCDE1234F']));
  const r2 = await sign(adv, advisory.id, fill);
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(r2.body.upgraded, true, 'advisory + one investment agreement makes them permanent');

  // An investor signs just one of the three
  const { m: inv, user: invUser } = await member(admin, 'investor', 'Choice Investor');
  list = (await inv('GET', '/api/member/agreements')).body;
  assert.deepEqual(list.agreements.map((a) => a.kind).sort(), ['convertible_note', 'shareholder_loan', 'term_sheet']);
  const note = list.agreements.find((a) => a.kind === 'convertible_note');
  const nf = (await inv('GET', `/api/member/agreements/${note.id}`)).body.spec.fields;
  const r3 = await sign(inv, note.id, Object.fromEntries(nf.filter((f) => f.src === 'member' && !f.type && !f.placeOf).map((f) => [f.key, '1'])));
  assert.equal(r3.status, 200, JSON.stringify(r3.body));
  assert.equal(r3.body.upgraded, true);
  assert.equal(db.prepare('SELECT access_type FROM users WHERE id = ?').get(invUser.id).access_type, 'permanent');
  // A withdrawn choice cannot be signed afterwards
  const tsInv = db.prepare("SELECT id FROM agreements WHERE user_id = ? AND kind = 'term_sheet'").get(invUser.id);
  assert.notEqual((await sign(inv, tsInv.id)).status, 200);

  // The approval email named the choice
  const mail = require('../server/mailer.js');
  const sent = mail.sent.filter((x) => x.to === 'choiceadvisor@example.com' && /agreements are ready/i.test(x.subject));
  assert.ok(sent.length, 'the advisor got one email for the set of agreements');
});

test('an unreadable PDF never stops the server', async () => {
  await assert.rejects(AGM.detectBlanks(Buffer.from('%PDF-1.4 this is not really a pdf')));
  const res = await fetch(base + '/healthz');
  assert.equal(res.status, 200);
});

test('blanks drawn as lines, dotted lines and form fields are found; table borders and rules are not', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.2, 841.92]);
  const text = (t, x, y) => page.drawText(t, { x, y, size: 11, font });
  text('Lender name:', 60, 720); page.drawLine({ start: { x: 135, y: 718 }, end: { x: 330, y: 718 }, thickness: 0.8 });   // drawn blank
  text('Amount: Rs. ......................... only', 60, 690);                                                            // dotted leader
  text('Email:', 60, 660);
  const form = doc.getForm(); form.createTextField('lender.email').addToPage(page, { x: 100, y: 655, width: 200, height: 16 });   // form field
  text('An underlined defined term', 60, 630); page.drawLine({ start: { x: 60, y: 628 }, end: { x: 190, y: 628 }, thickness: 0.6 });   // underlined words
  page.drawLine({ start: { x: 40, y: 600 }, end: { x: 555, y: 600 }, thickness: 1 });                                     // rule across the page
  page.drawRectangle({ x: 60, y: 520, width: 200, height: 40, borderWidth: 1 });                                           // a table cell
  const found = await AGM.detectBlanks(Buffer.from(await doc.save()));
  const by = (src) => found.blanks.filter((b) => b.source === src);
  assert.equal(found.blanks.length, 3, JSON.stringify(found.blanks));
  assert.equal(by('line').length, 1);
  assert.equal(by('line')[0].hint, 'Lender name:');
  assert.ok(Math.abs(by('line')[0].x - 135) < 2 && Math.abs(by('line')[0].w - 195) < 3);
  assert.equal(by('text')[0].hint, 'Amount: Rs.');
  assert.equal(by('field')[0].hint, 'Email:');
});

test('the admin can add, resize and remove blanks by hand', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { uid: 'admin', password: 'Vinc@2026' });
  const plain = await PDFDocument.create(); plain.addPage([595.2, 841.92]);   // a scan-like page: nothing to find
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from(await plain.save())], { type: 'application/pdf' }), 'scan.pdf');
  fd.append('title', 'Scanned side letter');
  const t = await admin('POST', '/api/admin/agreements/custom', undefined, fd);
  assert.equal(t.body.blanks, 0);
  const put = await admin('PUT', `/api/admin/agreements/custom/${t.body.id}`, { blanks: [
    { id: -1, manual: true, page: 1, x: 100, w: 160, line: 300, mode: 'member', label: 'Full name' },
    { id: -2, manual: true, page: 1, x: 100, w: 90, line: 340, mode: 'member_signature', label: '' },
  ] });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const list = put.body.blanks_list;
  assert.deepEqual(list.map((b) => [b.id, b.manual, b.mode]), [[1, true, 'member'], [2, true, 'member_signature']]);
  assert.equal(list[0].label, 'Full name');
  // Resize one and remove the other
  const again = await admin('PUT', `/api/admin/agreements/custom/${t.body.id}`, { blanks: [{ id: 1, manual: true, page: 1, x: 100, w: 260, line: 300, mode: 'member', label: 'Full name' }] });
  assert.equal(again.body.blanks_list.length, 1);
  assert.equal(again.body.blanks_list[0].w, 260);
  // Outside the page is refused
  assert.equal((await admin('PUT', `/api/admin/agreements/custom/${t.body.id}`, { blanks: [{ id: -1, manual: true, page: 2, x: 10, w: 100, line: 100, mode: 'member' }] })).status, 400);
});

test('"Find blanks again" keeps choices for blanks in the same place and blanks added by hand', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { uid: 'admin', password: 'Vinc@2026' });
  const fd = new FormData();
  fd.append('file', new Blob([await agreementPdf('SIDE LETTER')], { type: 'application/pdf' }), 'side.pdf');
  fd.append('title', 'Side letter');
  const t = await admin('POST', '/api/admin/agreements/custom', undefined, fd);
  const first = t.body.blanks_list[0];
  await admin('PUT', `/api/admin/agreements/custom/${t.body.id}`, { blanks: [
    { id: first.id, mode: 'member_name', label: '' },
    { id: -1, manual: true, page: 1, x: 300, w: 120, line: 400, mode: 'member', label: 'Witness' },
  ] });
  const r = await admin('POST', `/api/admin/agreements/custom/${t.body.id}/redetect`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.found, 5);
  assert.equal(r.body.blanks_list.find((b) => b.id === first.id).mode, 'member_name');
  const hand = r.body.blanks_list.find((b) => b.manual);
  assert.equal(hand.label, 'Witness');
  assert.equal(hand.id, 6);
});
