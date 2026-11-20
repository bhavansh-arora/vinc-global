'use strict';
// News attachments (PDF or image) and STEAM-IE shareholders (share-swap investors).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'vinc-global-test-'));
process.env.DATA_DIR = DATA;
process.env.MAIL_TRANSPORT = 'json';
const app = require('../server/index.js');
const { db } = require('../server/db.js');

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
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
  };
}
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a3bd6a5c0000000049454e44ae426082', 'hex');
const newsForm = (fields, file, name, type) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append('file', new Blob([file], { type }), name);
  return fd;
};

async function activeMember(admin, role, name) {
  const gen = await admin('POST', '/api/admin/users', { role, name, email: `${name.replace(/\W/g, '').toLowerCase()}@example.com`, password: 'abc12345', access: 'temporary' });
  assert.equal(gen.status, 200, JSON.stringify(gen.body));
  const m = client();
  assert.equal((await m('POST', '/api/auth/login', { uid: gen.body.uid, password: 'abc12345' })).status, 200);
  return { m, user: gen.body };
}

test('news can carry a PDF or an image, with the right visibility', async () => {
  const admin = client(), anon = client();
  await admin('POST', '/api/auth/login', { uid: 'admin', password: 'Vinc@2026' });

  // Members-only post with a PDF
  const p1 = await admin('POST', '/api/admin/news', undefined, newsForm({ title: 'Board pack', body: 'Q3 board pack attached.', visibility: 'members', pinned: '1', notify: '0' }, PDF, 'board-pack.pdf', 'application/pdf'));
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  assert.equal(p1.body.has_file, 1);
  assert.equal(p1.body.file_mime, 'application/pdf');
  assert.equal(p1.body.pinned, 1);
  assert.equal(p1.body.file_stored, undefined, 'stored file names are not exposed');

  // Public post with only an image (no text)
  const p2 = await admin('POST', '/api/admin/news', undefined, newsForm({ title: 'Lab photo', body: '', visibility: 'public', notify: '0' }, PNG, 'lab.png', 'image/png'));
  assert.equal(p2.status, 200, JSON.stringify(p2.body));
  assert.equal(p2.body.file_mime, 'image/png');

  // A post needs text or a file; a disguised file is refused
  assert.equal((await admin('POST', '/api/admin/news', undefined, newsForm({ title: 'Empty', body: '' }))).status, 400);
  assert.equal((await admin('POST', '/api/admin/news', undefined, newsForm({ title: 'Fake', body: 'x' }, Buffer.from('not an image'), 'x.png', 'image/png'))).status, 400);
  assert.equal((await admin('POST', '/api/admin/news', undefined, newsForm({ title: 'Sheet', body: 'x' }, Buffer.from('a,b'), 'x.csv', 'text/csv'))).status, 400);

  // Plain JSON posts still work
  assert.equal((await admin('POST', '/api/admin/news', { title: 'Text only', body: 'Hello', notify: false })).status, 200);

  // Public site: the image is open to all, the members-only PDF is not
  const pub = await anon('GET', '/api/auth/news');
  assert.ok(pub.body.some((n) => n.id === p2.body.id && n.has_file === 1));
  assert.ok(!pub.body.some((n) => n.id === p1.body.id));
  const img = await anon('GET', `/api/auth/news/${p2.body.id}/file`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('cache-control'), 'no-store, private');
  assert.equal((await anon('GET', `/api/auth/news/${p1.body.id}/file`)).status, 404);

  // An active member sees both
  const { m } = await activeMember(admin, 'investor', 'News Reader');
  const ov = await m('GET', '/api/member/overview');
  const item = ov.body.news.find((n) => n.id === p1.body.id);
  assert.equal(item.has_file, 1);
  assert.equal(item.file_name, 'board-pack.pdf');
  const pdf = await m('GET', `/api/auth/news/${p1.body.id}/file`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');

  // Deleting the post removes the file too
  const stored = db.prepare('SELECT file_stored FROM news WHERE id = ?').get(p1.body.id).file_stored;
  const p = path.join(DATA, 'uploads', stored);
  assert.ok(fs.existsSync(p));
  assert.equal((await admin('DELETE', `/api/admin/news/${p1.body.id}`)).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!fs.existsSync(p));
  assert.equal((await m('GET', `/api/auth/news/${p1.body.id}/file`)).status, 404);
});

test('STEAM-IE shareholders are investors with no onboarding agreement for now', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { uid: 'admin', password: 'Vinc@2026' });
  // The Investor Term Sheet is uploaded, so ordinary investors get it automatically
  const doc = await PDFDocument.create();
  for (let i = 0; i < 9; i++) doc.addPage([595, 842]);
  const fd = new FormData();
  const tsBuf = Buffer.from(await doc.save());
  require('../server/agreements.js').KINDS.term_sheet.sha256 = require('node:crypto').createHash('sha256').update(tsBuf).digest('hex');   // stand-in for the real file
  fd.append('file', new Blob([tsBuf], { type: 'application/pdf' }), 'term_sheet.pdf');
  assert.equal((await admin('POST', '/api/admin/agreements/templates/term_sheet', undefined, fd)).status, 200);

  const { m: sie, user } = await activeMember(admin, 'steam_ie', 'Swap Holder');
  assert.match(user.uid, /^VG-SIE-[A-Z0-9]{6}$/);
  assert.equal(user.role, 'investor');
  assert.equal(user.investor_type, 'steam_ie');
  assert.equal(user.member_label, 'STEAM-IE shareholder');

  // Nothing to sign; the page says their agreement is being prepared
  const list = await sie('GET', '/api/member/agreements');
  assert.equal(list.status, 200);
  assert.equal(list.body.agreements.length, 0);
  assert.equal(list.body.steam_ie, true);
  assert.equal(list.body.waiting_for_template, true);
  assert.equal(list.body.all_executed, false);
  const ov = await sie('GET', '/api/member/overview');
  assert.equal(ov.body.agreements.length, 0);
  assert.equal(ov.body.user.member_label, 'STEAM-IE shareholder');
  // ...and they are not upgraded to permanent just because nothing is required
  assert.equal(db.prepare('SELECT access_type FROM users WHERE id = ?').get(user.id).access_type, 'temporary');

  // An ordinary investor does get the term sheet
  const { m: inv, user: invUser } = await activeMember(admin, 'investor', 'Direct Investor');
  assert.equal((await inv('GET', '/api/member/agreements')).body.agreements[0].kind, 'term_sheet');

  // Approving the STEAM-IE shareholder again sends nothing to sign
  await admin('POST', `/api/admin/users/${user.id}/approve`, { type: 'temporary' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agreements WHERE user_id = ?').get(user.id).n, 0);

  // The admin list and the agreements overview show them as STEAM-IE shareholders, with nothing "not sent"
  const users = await admin('GET', '/api/admin/users');
  assert.equal(users.body.find((u) => u.id === user.id).investor_type, 'steam_ie');
  const ag = await admin('GET', '/api/admin/agreements');
  assert.ok(!ag.body.rows.some((r) => r.user.id === user.id));
  assert.equal(ag.body.members.find((x) => x.id === user.id).label, 'STEAM-IE shareholder');
  assert.equal((await admin('GET', '/api/admin/stats')).body.steam_ie, 1);

  // STEAM-IE shareholders can be reached on their own, and "All investors" includes them
  const custom = await PDFDocument.create(); custom.addPage([595, 842]);
  const cf = new FormData();
  cf.append('file', new Blob([Buffer.from(await custom.save())], { type: 'application/pdf' }), 'swap.pdf');
  cf.append('title', 'STEAM-IE Share Swap Agreement');
  const tpl = await admin('POST', '/api/admin/agreements/custom', undefined, cf);
  assert.equal(tpl.status, 200, JSON.stringify(tpl.body));
  const tid = tpl.body.id || (tpl.body.template && tpl.body.template.id);
  const toSwap = await admin('POST', '/api/admin/agreements/send', { template_id: tid, audience: 'steam_ie' });
  assert.equal(toSwap.body.sent, 1);
  assert.equal((await sie('GET', '/api/member/agreements')).body.agreements[0].title, 'STEAM-IE Share Swap Agreement');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agreements WHERE template_id = ?').get(tid).n, 1, 'only the STEAM-IE shareholder got it');
  // A second document sent to "All investors" reaches direct investors and STEAM-IE shareholders alike
  const doc2 = await PDFDocument.create(); doc2.addPage([595, 842]);
  const cf2 = new FormData();
  cf2.append('file', new Blob([Buffer.from(await doc2.save())], { type: 'application/pdf' }), 'notice.pdf');
  cf2.append('title', 'Investor Notice');
  const tpl2 = await admin('POST', '/api/admin/agreements/custom', undefined, cf2);
  const tid2 = tpl2.body.id || (tpl2.body.template && tpl2.body.template.id);
  const toInvestors = await admin('POST', '/api/admin/agreements/send', { template_id: tid2, audience: 'investors' });
  assert.equal(toInvestors.body.sent, db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'investor'").get().n);
  assert.ok((await sie('GET', '/api/member/agreements')).body.agreements.some((a) => a.title === 'Investor Notice'));

  // Turning an investor into a STEAM-IE shareholder withdraws the unsigned term sheet
  const ch = await admin('PATCH', `/api/admin/users/${invUser.id}`, { role: 'steam_ie' });
  assert.equal(ch.body.member_label, 'STEAM-IE shareholder');
  const open = db.prepare("SELECT status FROM agreements WHERE user_id = ? AND kind = 'term_sheet'").all(invUser.id);
  assert.ok(open.every((a) => a.status === 'void'));
  assert.equal((await inv('GET', '/api/member/agreements')).body.agreements.filter((a) => a.kind === 'term_sheet').length, 0);

  // Website requests can be approved as STEAM-IE shareholders
  db.prepare("INSERT INTO id_requests (name, email, role, status, created_at) VALUES ('Req Holder', 'req@example.com', 'investor', 'new', ?)").run(Date.now());
  const rq = db.prepare("SELECT id FROM id_requests WHERE email = 'req@example.com'").get();
  const ap = await admin('POST', `/api/admin/requests/${rq.id}/approve`, { role: 'steam_ie' });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.match(ap.body.uid, /^VG-SIE-/);
});
