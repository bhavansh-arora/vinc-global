'use strict';
// Onboarding agreements: upload, sign, countersign (by hand and automatically), permanent upgrade, void.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { PDFDocument } = require('pdf-lib');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'vinc-global-agr-'));
process.env.DATA_DIR = DATA;
process.env.MAIL_TRANSPORT = 'json';
process.env.ADMIN_EMAIL = 'founder@example.com';
const app = require('../server/index.js');
const mail = require('../server/mailer.js');

let server, base;
before(async () => { server = app.listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async (method, url, body, form) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    let payload;
    if (form) payload = form; else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, type, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
}
const settle = async () => { await new Promise((r) => setTimeout(r, 40)); await mail.drain(); };
const mails = () => mail.sent.splice(0);

async function pdfWithPages(n) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([595.2, 841.92]);
  return Buffer.from(await doc.save());
}
function pngDataUrl() {
  const crc = (buf) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let x = 0xffffffff; for (const b of buf) x = t[(x ^ b) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const w = 60, h = 20, raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; if (Math.abs(y - 10 - Math.round(6 * Math.sin(x / 5))) < 2) { raw[o] = 16; raw[o + 1] = 34; raw[o + 2] = 92; raw[o + 3] = 255; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + png.toString('base64');
}
const upload = (c, kind, buf) => { const fd = new FormData(); fd.append('file', new Blob([buf], { type: 'application/pdf' }), `${kind}.pdf`); return c('POST', `/api/admin/agreements/templates/${kind}`, undefined, fd); };
const FIELDS = { name: 'Asha Rao', relation_type: 'W/o', relation_name: 'Vikram Rao', address1: '42, 3rd Cross, Indiranagar', address2: 'Bengaluru 560038', pan: 'BQRPR5678L', email: 'asha@example.com', phone: '+91 99000 54321' };

test('advisor signs, admin countersigns, advisor becomes permanent', async () => {
  const admin = client(), adv = client(), other = client();
  await admin('POST', '/api/auth/login', { uid: 'admin', password: 'Vinc@2026' });

  // Wrong page count is refused; the 6-page advisory agreement is accepted
  assert.equal((await upload(admin, 'advisory', await pdfWithPages(3))).status, 400);
  const tpl = await upload(admin, 'advisory', await pdfWithPages(6));
  assert.equal(tpl.status, 200);
  assert.equal(tpl.body.matches_layout, false, 'a different file than the measured one is flagged');

  // A temporary advisor sees their agreement ready to sign
  const gen = await admin('POST', '/api/admin/users', { role: 'advisor', name: 'Asha Rao', email: 'asha@example.com', password: 'Secret123', access: 'temporary' });
  await adv('POST', '/api/auth/login', { uid: gen.body.uid, password: 'Secret123' });
  const list = await adv('GET', '/api/member/agreements');
  assert.equal(list.body.agreements.length, 1);
  const ag = list.body.agreements[0];
  assert.equal(ag.kind, 'advisory');
  assert.equal(ag.status, 'pending');
  const detail = await adv('GET', `/api/member/agreements/${ag.id}`);
  assert.ok(detail.body.spec.fields.some((f) => f.key === 'pan'));
  assert.equal((await adv('GET', `/api/member/agreements/${ag.id}/document`)).type, 'application/pdf');

  // Someone else cannot see it
  const g2 = await admin('POST', '/api/admin/users', { role: 'advisor', name: 'Other', password: 'Secret123', access: 'temporary' });
  await other('POST', '/api/auth/login', { uid: g2.body.uid, password: 'Secret123' });
  assert.equal((await other('GET', `/api/member/agreements/${ag.id}`)).status, 404);
  mails();

  // Bad PAN, no consent, no signature are refused
  assert.match((await adv('POST', `/api/member/agreements/${ag.id}/sign`, { fields: { ...FIELDS, pan: 'XYZ' }, place: 'Bengaluru', consent: true, signature: pngDataUrl() })).body.error, /PAN/);
  assert.equal((await adv('POST', `/api/member/agreements/${ag.id}/sign`, { fields: FIELDS, place: 'Bengaluru', consent: false, signature: pngDataUrl() })).status, 400);
  assert.equal((await adv('POST', `/api/member/agreements/${ag.id}/sign`, { fields: FIELDS, place: 'Bengaluru', consent: true })).status, 400);

  // Sign
  const signed = await adv('POST', `/api/member/agreements/${ag.id}/sign`, { fields: FIELDS, place: 'Bengaluru, Karnataka', consent: true, signature: pngDataUrl(), geo: { lat: 12.97, lon: 77.59, acc: 30 } });
  assert.equal(signed.status, 200);
  assert.equal(signed.body.executed, false);
  assert.equal(signed.body.user.access_type, 'temporary');
  assert.equal((await adv('POST', `/api/member/agreements/${ag.id}/sign`, { fields: FIELDS, place: 'X', consent: true, signature: pngDataUrl() })).status, 409);
  await settle();
  assert.ok(mails().some((m) => m.to === 'founder@example.com' && /signed the Advisory Agreement/.test(m.subject)));
  assert.equal((await admin('GET', '/api/admin/stats')).body.agreements_to_sign, 1);

  // Admin sees the details captured, previews, then countersigns
  const ad = await admin('GET', `/api/admin/agreements/${ag.id}`);
  assert.equal(ad.body.agreement.member_place, 'Bengaluru, Karnataka');
  assert.equal(ad.body.agreement.member_geo.lat, 12.97);
  assert.ok(ad.body.agreement.member_ip);
  assert.equal((await admin('GET', `/api/admin/agreements/${ag.id}/pdf`)).type, 'application/pdf');
  const cs = await admin('POST', `/api/admin/agreements/${ag.id}/countersign`, { place: 'Bengaluru', signature: pngDataUrl(), save_signature: true });
  assert.equal(cs.status, 200);
  assert.equal(cs.body.agreement.status, 'executed');
  assert.equal(cs.body.upgraded, true);
  assert.equal(cs.body.user.access_type, 'permanent');
  await settle();
  const m = mails();
  const exec = m.filter((x) => /Executed|Signed: your/.test(x.subject));
  assert.equal(exec.length, 2, 'member and admin both get the executed copy');
  assert.ok(exec.every((x) => x.attachments.length === 1 && x.attachments[0].endsWith('.pdf')));
  assert.ok(m.some((x) => x.kind === 'approved' && /permanent/.test(x.subject)));

  // The executed PDF has the certificate page and can be downloaded by the member
  const pdf = await adv('GET', `/api/member/agreements/${ag.id}/document?download=1`);
  assert.equal(pdf.type, 'application/pdf');
  assert.equal((await PDFDocument.load(pdf.body)).getPageCount(), 7);

  // Voiding asks for a fresh signature
  await admin('POST', `/api/admin/agreements/${ag.id}/void`, { reason: 'PAN was mistyped' });
  const again = await adv('GET', '/api/member/agreements');
  assert.equal(again.body.agreements.length, 1);
  assert.equal(again.body.agreements[0].status, 'pending');
  assert.equal(again.body.agreements[0].last_void_reason, 'PAN was mistyped');
});

test('with automatic countersigning, an investor is permanent as soon as they sign', async () => {
  const admin = client(), inv = client();
  await admin('POST', '/api/auth/login', { uid: 'admin', password: 'Vinc@2026' });
  await upload(admin, 'term_sheet', await pdfWithPages(9));
  const auto = await admin('PUT', '/api/admin/agreements/company', { auto: true, place: 'Bengaluru' });
  assert.equal(auto.body.auto, true);
  const gen = await admin('POST', '/api/admin/users', { role: 'investor', name: 'Neha Gupta', email: 'neha@example.com', password: 'Secret123', access: 'temporary' });
  await inv('POST', '/api/auth/login', { uid: gen.body.uid, password: 'Secret123' });
  const [ag] = (await inv('GET', '/api/member/agreements')).body.agreements;
  assert.equal(ag.kind, 'term_sheet');
  const noTicket = await inv('POST', `/api/member/agreements/${ag.id}/sign`, { fields: { ...FIELDS, name: 'Neha Gupta', residence: 'resident' }, place: 'Mumbai', consent: true, signature: pngDataUrl() });
  assert.match(noTicket.body.error, /ticket/);
  const res = await inv('POST', `/api/member/agreements/${ag.id}/sign`, { fields: { ...FIELDS, name: 'Neha Gupta', residence: 'resident', ticket: '2' }, place: 'Mumbai', consent: true, signature: pngDataUrl() });
  assert.equal(res.body.executed, true);
  assert.equal(res.body.upgraded, true);
  assert.equal(res.body.user.access_type, 'permanent');
  assert.equal(res.body.all_executed, true);
  const pdf = await inv('GET', `/api/member/agreements/${ag.id}/document`);
  assert.equal((await PDFDocument.load(pdf.body)).getPageCount(), 10);
});
