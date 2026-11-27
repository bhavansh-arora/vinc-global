'use strict';
// View-only accounts (e.g. the Company Secretary): every published document and every signed agreement,
// view only; nothing else in the portal, and never treated as a member.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PDFDocument } = require('pdf-lib');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'vinc-global-test-'));
process.env.DATA_DIR = DATA;
process.env.MAIL_TRANSPORT = 'json';
const app = require('../server/index.js');
const { db } = require('../server/db.js');
const AGM = require('../server/agreements.js');
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
    if (form) payload = form;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
}
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');

test('a view-only login sees every document and every signed agreement, and nothing else', async () => {
  const admin = client();
  await admin('POST', '/api/auth/login', { uid: 'admin', password: 'Vinc@2026' });
  // A member, a document for everyone and one for that member only
  const gen = await admin('POST', '/api/admin/users', { role: 'advisor', name: 'Asha Rao', email: 'asha@example.com', password: 'abc12345', access: 'temporary' });
  const member = gen.body;
  const up = (title, audience) => { const fd = new FormData(); fd.append('kind', 'pdf'); fd.append('title', title); fd.append('category', 'legal'); if (audience) fd.append('audience_user_id', String(audience)); fd.append('file', new Blob([PDF], { type: 'application/pdf' }), 'x.pdf'); return admin('POST', '/api/admin/documents', undefined, fd); };
  const pub = await up('Board resolution', null);
  const personal = await up('Asha side letter', member.id);
  assert.equal(pub.status, 200); assert.equal(personal.status, 200);
  // A signed agreement and an unsigned one
  const tpl = await (async () => { const d = await PDFDocument.create(); d.addPage(); const fd = new FormData(); fd.append('title', 'NDA'); fd.append('file', new Blob([Buffer.from(await d.save())], { type: 'application/pdf' }), 'nda.pdf'); return (await admin('POST', '/api/admin/agreements/custom', undefined, fd)).body; })();
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(member.id);
  const { agreement: signedAg } = AGM.ensureFor(u, AGM.templateById(tpl.id), 'Test');
  db.prepare("UPDATE agreements SET status = 'member_signed', member_signed_at = ?, member_place = 'Pune', fields = '{}' WHERE id = ?").run(Date.now(), signedAg.id);
  const d2 = await PDFDocument.create(); d2.addPage();
  const fd2 = new FormData(); fd2.append('title', 'Unsigned letter'); fd2.append('file', new Blob([Buffer.from(await d2.save())], { type: 'application/pdf' }), 'u.pdf');
  const tpl2 = (await admin('POST', '/api/admin/agreements/custom', undefined, fd2)).body;
  AGM.ensureFor(u, AGM.templateById(tpl2.id), 'Test');

  // The admin creates the view-only login; the password is generated and returned once
  const v = await admin('POST', '/api/admin/viewers', { name: 'Neha Sharma', organisation: 'Company Secretary' });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.uid, 'VG-CS-01');
  assert.match(v.body.password, /^[A-Za-z0-9]{14}$/);
  assert.equal((await admin('GET', '/api/admin/viewers')).body[0].password, undefined, 'never shown again');

  const cs = client();
  const login = await cs('POST', '/api/auth/login', { uid: 'VG-CS-01', password: v.body.password });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, 'viewer');
  assert.equal(login.body.user.member_label, 'Company Secretary (view only)');

  // Documents: all of them, including the one shared with one member, and they open
  const docs = (await cs('GET', '/api/cs/documents')).body;
  assert.deepEqual(docs.map((d) => d.title).sort(), ['Asha side letter', 'Board resolution']);
  assert.equal(docs.find((d) => d.title === 'Asha side letter').audience_name, 'Asha Rao');
  const raw = await cs('GET', `/api/files/doc/${personal.body.id}/raw`);
  assert.equal(raw.status, 200);
  // Signed agreements: only signed ones, and they open
  const ags = (await cs('GET', '/api/cs/agreements')).body;
  assert.deepEqual(ags.map((a) => a.title), ['NDA']);
  assert.equal(ags[0].member.uid, member.uid);
  const pdf = await cs('GET', `/api/cs/agreements/${signedAg.id}/pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
  const unsignedId = db.prepare("SELECT id FROM agreements WHERE status = 'pending'").get().id;
  assert.equal((await cs('GET', `/api/cs/agreements/${unsignedId}/pdf`)).status, 404);
  // Views are recorded
  const log = (await admin('GET', `/api/admin/viewers/${v.body.id}/log`)).body.map((l) => l.action);
  assert.ok(log.includes('viewed_document') && log.includes('viewed_agreement') && log.includes('login'));

  // Nothing else: no member area, no admin area, no changes
  assert.equal((await cs('GET', '/api/member/overview')).status, 403);
  const own = await cs('GET', '/api/member/agreements');
  assert.equal(own.status, 200, 'they can open agreements sent to them to sign');
  assert.deepEqual(own.body.agreements, [], 'and are given no standard documents');
  assert.equal(own.body.waiting_for_template, false);
  assert.equal((await cs('GET', '/api/admin/users')).status, 403);
  assert.equal((await cs('DELETE', `/api/admin/documents/${pub.body.id}`)).status, 403);
  assert.equal((await cs('GET', '/api/chat')).status, 403);
  // Members cannot use the view-only area
  const m = client();
  await m('POST', '/api/auth/login', { uid: member.uid, password: 'abc12345' });
  assert.equal((await m('GET', '/api/cs/documents')).status, 403);

  // Never treated as a member: not listed, not counted, not emailed, not included in "all members"
  assert.ok(!(await admin('GET', '/api/admin/users')).body.some((x) => x.uid === 'VG-CS-01'));
  assert.equal((await admin('GET', '/api/admin/stats')).body.members, 1);
  // ...but they can be picked to sign agreements, under their designation
  assert.equal((await admin('GET', '/api/admin/agreements')).body.members.find((x) => x.uid === 'VG-CS-01').designation, 'Company Secretary');
  const sent = await admin('POST', '/api/admin/agreements/send', { template_id: tpl2.id, audience: 'all' });
  assert.equal(sent.body.sent + sent.body.reminded + sent.body.skipped, 1);
  mail.sent.length = 0;
  await admin('POST', '/api/admin/news', { title: 'Update', body: 'Hello', notify: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!mail.sent.some((x) => /neha/i.test(x.to || '')));

  // A new password logs them out; revoking stops access
  const np = await admin('POST', `/api/admin/viewers/${v.body.id}/password`);
  assert.equal(np.status, 200, JSON.stringify(np.body));
  assert.match(np.body.password, /^[A-Za-z0-9]{14}$/);
  assert.notEqual(np.body.password, v.body.password);
  assert.equal((await cs('GET', '/api/cs/documents')).status, 401);
  assert.equal((await cs('POST', '/api/auth/login', { uid: 'VG-CS-01', password: np.body.password })).status, 200);
  await admin('POST', `/api/admin/viewers/${v.body.id}/revoke`);
  assert.equal((await cs('GET', '/api/cs/documents')).status, 401);
  assert.equal((await cs('POST', '/api/auth/login', { uid: 'VG-CS-01', password: np.body.password })).status, 403);
});

test('the command-line tool creates a view-only login with a generated password', () => {
  const out = execFileSync(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'tools', 'add-viewer.js'), 'Ravi Kumar', 'VG-CS-07'], { env: { ...process.env, DATA_DIR: DATA } }).toString();
  assert.match(out, /VINC ID:\s+VG-CS-07/);
  const pwd = out.match(/Password:\s+(\S+)/)[1];
  const row = db.prepare("SELECT * FROM users WHERE uid = 'VG-CS-07'").get();
  assert.equal(row.role, 'viewer');
  assert.ok(require('bcryptjs').compareSync(pwd, row.password_hash));
  // Running it again gives a new password
  const again = execFileSync(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'tools', 'add-viewer.js'), 'Ravi Kumar', 'VG-CS-07'], { env: { ...process.env, DATA_DIR: DATA } }).toString();
  assert.match(again, /Updated view-only account VG-CS-07/);
  // It will not touch a member's ID
  assert.throws(() => execFileSync(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'server', 'tools', 'add-viewer.js'), 'X', 'ADMIN'], { env: { ...process.env, DATA_DIR: DATA }, stdio: 'pipe' }));
});
