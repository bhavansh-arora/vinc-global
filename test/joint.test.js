'use strict';
// Anyone on the portal (members, directors, the company secretary, staff) can be asked to sign; an agreement
// can go to several people as one shared copy; and everything the admin sends must be signed.
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
process.env.ADMIN_EMAIL = 'founder@example.com';
const app = require('../server/index.js');
const { db } = require('../server/db.js');
const mail = require('../server/mailer.js');

let server, base;
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
function pngDataUrl() {
  const crc = (buf) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let x = 0xffffffff; for (const b of buf) x = t[(x ^ b) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const w = 60, h = 20, raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; if (Math.abs(y - 10 - Math.round(6 * Math.sin(x / 5))) < 2) { raw[o] = 16; raw[o + 1] = 34; raw[o + 2] = 92; raw[o + 3] = 255; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
async function resolutionPdf() {
  const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.2, 841.92]);
  page.drawText('BOARD RESOLUTION', { x: 60, y: 780, size: 16, font });
  page.drawText('Director name: ______________________', { x: 60, y: 720, size: 11, font });
  page.drawText('Date of meeting: ______________', { x: 60, y: 690, size: 11, font });
  return Buffer.from(await doc.save());
}
const sign = (c, id, fields = {}) => c('POST', `/api/member/agreements/${id}/sign`, { fields, place: 'Bengaluru', signature: pngDataUrl(), consent: true });

let admin, tplId;
const people = {};
before(async () => {
  server = app.listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`;
  admin = client();
  await admin('POST', '/api/auth/login', { uid: 'admin', password: 'Vinc@2026' });
  await admin('PUT', '/api/admin/agreements/company', { signature: pngDataUrl(), auto: false });
  const fd = new FormData();
  fd.append('title', 'Board Resolution'); fd.append('required', '0');   // the old "optional" choice is ignored
  fd.append('file', new Blob([await resolutionPdf()], { type: 'application/pdf' }), 'br.pdf');
  const t = await admin('POST', '/api/admin/agreements/custom', undefined, fd);
  tplId = t.body.id;
  assert.equal(t.body.required, true, 'every agreement the admin sends is required');
  // Two directors and a company secretary (view-only), and an advisor
  for (const [key, name, organisation] of [['d1', 'Rachit Arora', 'Director'], ['d2', 'Meera Iyer', 'Director'], ['cs', 'Neha Sharma', 'Company Secretary']]) {
    const v = await admin('POST', '/api/admin/viewers', { name, organisation, email: `${key}@example.com` });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    const c = client();
    assert.equal((await c('POST', '/api/auth/login', { uid: v.body.uid, password: v.body.password })).status, 200);
    people[key] = { c, id: v.body.id, uid: v.body.uid };
  }
  const g = await admin('POST', '/api/admin/users', { role: 'advisor', name: 'Asha Rao', email: 'asha@example.com', password: 'abc12345', access: 'temporary' });
  const c = client();
  await c('POST', '/api/auth/login', { uid: g.body.uid, password: 'abc12345' });
  people.adv = { c, id: g.body.id, uid: g.body.uid };
});

test('directors and the company secretary can be picked, and sign agreements sent to them', async () => {
  const list = (await admin('GET', '/api/admin/agreements')).body.members;
  assert.equal(list.find((m) => m.uid === people.d1.uid).label, 'Director (view only)');
  // "All directors" reaches the two directors only, each with their own required copy
  const r = await admin('POST', '/api/admin/agreements/send', { template_id: tplId, audience: 'directors' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sent, 2);
  const mine = (await people.d1.c('GET', '/api/member/agreements')).body;
  assert.equal(mine.viewer, true);
  assert.equal(mine.agreements.length, 1);
  assert.equal(mine.agreements[0].mandatory, true);
  assert.equal(mine.agreements[0].joint, null);
  // The email takes them to their own page
  await mail.drain();
  const email = mail.sent.filter((x) => x.to === 'd1@example.com').pop();
  assert.match(JSON.stringify(email), /\/cs#agreements/);
  // They sign it; the admin countersigns; it is executed
  const detail = (await people.d1.c('GET', `/api/member/agreements/${mine.agreements[0].id}`)).body;
  const fill = Object.fromEntries(detail.spec.fields.filter((f) => f.src === 'member' && !f.type && !f.placeOf && !f.optional).map((f) => [f.key, 'Rachit Arora']));
  const s = await sign(people.d1.c, mine.agreements[0].id, fill);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const cs = await admin('POST', `/api/admin/agreements/${mine.agreements[0].id}/countersign`, { place: 'Bengaluru' });
  assert.equal(cs.status, 200, JSON.stringify(cs.body));
  assert.equal(cs.body.agreement.status, 'executed');
  // A view-only user is still not a member: no upgrade, no standard documents
  assert.equal(cs.body.upgraded, false);
});

test('several people sign one shared copy; the company countersigns once; one PDF for all', async () => {
  const ids = [people.d1.id, people.d2.id, people.adv.id];
  assert.equal((await admin('POST', '/api/admin/agreements/send', { template_id: tplId, user_ids: [people.d1.id], joint: true })).status, 400, 'a shared copy needs two or more');
  const r = await admin('POST', '/api/admin/agreements/send', { template_id: tplId, user_ids: ids, joint: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sent, 3);
  assert.match(r.body.joint, /^VG-JNT-/);
  const copies = db.prepare('SELECT * FROM agreements WHERE joint_ref = ? ORDER BY id').all(r.body.joint);
  assert.equal(copies.length, 3);
  assert.ok(copies.every((c) => c.mandatory === 1));

  // Each sees who else signs; personal blanks are left out of a shared copy
  const adv = (await people.adv.c('GET', '/api/member/agreements')).body.agreements.find((a) => a.joint);
  assert.equal(adv.joint.total, 3);
  assert.equal(adv.joint.signed, 0);
  const detail = (await people.adv.c('GET', `/api/member/agreements/${adv.id}`)).body;
  assert.equal(detail.spec.fields.filter((f) => f.src === 'member').length, 0);

  // Two sign; the admin cannot countersign yet
  const first = await sign(people.adv.c, adv.id);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.waiting_for_others, true);
  const d1Copy = copies.find((c) => c.user_id === people.d1.id);
  assert.equal((await sign(people.d1.c, d1Copy.id)).status, 200);
  const early = await admin('POST', `/api/admin/agreements/${d1Copy.id}/countersign`, { place: 'Bengaluru' });
  assert.equal(early.status, 409);
  assert.match(early.body.error, /Meera Iyer/);
  // The last one signs; the admin is told everyone has signed
  mail.sent.length = 0;
  const d2Copy = copies.find((c) => c.user_id === people.d2.id);
  assert.equal((await sign(people.d2.c, d2Copy.id)).status, 200);
  await mail.drain();
  assert.ok(mail.sent.some((x) => /All 3 signatories/.test(JSON.stringify(x))));
  // One countersignature executes every copy with the same PDF
  const done = await admin('POST', `/api/admin/agreements/${d2Copy.id}/countersign`, { place: 'Bengaluru' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const after = db.prepare('SELECT status, executed_name FROM agreements WHERE joint_ref = ?').all(r.body.joint);
  assert.ok(after.every((a) => a.status === 'executed'));
  assert.equal(new Set(after.map((a) => a.executed_name)).size, 1);
  // The signature page lists the company and all three signers (two pages: 2 blocks per row, 2 rows per page)
  const pdf = await admin('GET', `/api/admin/agreements/${d1Copy.id}/pdf`);
  const doc = await PDFDocument.load(pdf.body);
  assert.ok(doc.getPageCount() >= 4, `page count ${doc.getPageCount()}`);
  // The company secretary sees it among the signed agreements, with its shared reference
  const seen = (await people.cs.c('GET', '/api/cs/agreements')).body.filter((a) => a.ref === r.body.joint);
  assert.equal(seen.length, 3);
  assert.equal(seen[0].joint.complete, true);
});

test('voiding a shared copy withdraws it for everyone', async () => {
  const r = await admin('POST', '/api/admin/agreements/send', { template_id: tplId, user_ids: [people.d1.id, people.cs.id], joint: true });
  const one = db.prepare('SELECT id FROM agreements WHERE joint_ref = ? ORDER BY id LIMIT 1').get(r.body.joint);
  const v = await admin('POST', `/api/admin/agreements/${one.id}/void`, { reason: 'Wrong date' });
  assert.equal(v.status, 200);
  assert.ok(db.prepare('SELECT status FROM agreements WHERE joint_ref = ?').all(r.body.joint).every((a) => a.status === 'void'));
});
