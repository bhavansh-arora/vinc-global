'use strict';
// End-to-end API tests against a throwaway database: node --test test/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'vinc-global-test-'));
process.env.DATA_DIR = DATA;
const app = require('../server/index.js');
const { db } = require('../server/db.js');

let server, base;
before(async () => { server = app.listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

// A tiny cookie-keeping client.
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
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.arrayBuffer(), headers: res.headers };
  };
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');

test('default admin can log in and manage the portal', async () => {
  const admin = client();
  const bad = await admin('POST', '/api/auth/login', { uid: 'admin', password: 'wrong' });
  assert.equal(bad.status, 401);
  const ok = await admin('POST', '/api/auth/login', { uid: 'admin', password: 'Vinc@2026' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, 'admin');
  const stats = await admin('GET', '/api/admin/stats');
  assert.equal(stats.status, 200);
});

test('full advisor journey: ID, sign-up, approval, documents, chat, expiry and renewal', async () => {
  const admin = client(), adv = client();
  await admin('POST', '/api/auth/login', { uid: 'admin', password: 'Vinc@2026' });

  // Admin generates an ID
  const gen = await admin('POST', '/api/admin/users', { role: 'advisor', name: 'Test Advisor' });
  assert.equal(gen.status, 200);
  const uid = gen.body.uid;
  assert.match(uid, /^VG-ADV-[A-Z0-9]{6}$/);

  // Unknown IDs cannot sign up; the real one can, once
  assert.equal((await adv('POST', '/api/auth/signup', { uid: 'VG-ADV-NOPE00', name: 'X', email: 'x@y.z', password: 'abc12345' })).status, 404);
  const weak = await adv('POST', '/api/auth/signup', { uid, name: 'Test', email: 't@example.com', password: 'short' });
  assert.equal(weak.status, 400);
  const su = await adv('POST', '/api/auth/signup', { uid, name: 'Test Advisor', email: 't@example.com', password: 'Secret123' });
  assert.equal(su.status, 200);
  assert.equal(su.body.user.state, 'pending');
  assert.equal((await adv('POST', '/api/auth/signup', { uid, name: 'Again', email: 't@example.com', password: 'Secret123' })).status, 409);

  // Pending members cannot see anything yet
  assert.equal((await adv('GET', '/api/member/overview')).status, 403);
  assert.equal((await adv('GET', '/api/chat')).status, 403);
  assert.equal((await adv('GET', '/api/admin/users')).status, 403);

  // Admin publishes a PDF, rejects a fake one, and approves a 72-hour window
  const fd = new FormData();
  fd.append('kind', 'pdf'); fd.append('title', 'Board resolution'); fd.append('category', 'board_resolutions');
  fd.append('file', new Blob([PDF], { type: 'application/pdf' }), 'br.pdf');
  const up = await admin('POST', '/api/admin/documents', undefined, fd);
  assert.equal(up.status, 200);
  const fake = new FormData();
  fake.append('kind', 'pdf'); fake.append('title', 'Fake');
  fake.append('file', new Blob(['not a pdf'], { type: 'application/pdf' }), 'fake.pdf');
  assert.equal((await admin('POST', '/api/admin/documents', undefined, fake)).status, 400);
  const link = await admin('POST', '/api/admin/documents', { kind: 'link', title: 'Deck', url: 'javascript:alert(1)' });
  assert.equal(link.status, 400);

  const userId = su.body.user.id;
  const ap = await admin('POST', `/api/admin/users/${userId}/approve`, { type: 'temporary' });
  assert.equal(ap.body.state, 'active');
  assert.ok(Math.abs(ap.body.access_expires_at - Date.now() - 72 * 3600e3) < 60e3);

  // Now the advisor sees the data room and can view the PDF inline, uncached
  const ov = await adv('GET', '/api/member/overview');
  assert.equal(ov.status, 200);
  assert.equal(ov.body.documents.length, 1);
  const raw = await adv('GET', `/api/files/doc/${ov.body.documents[0].id}/raw`);
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get('content-disposition'), /^inline/);
  assert.match(raw.headers.get('cache-control'), /no-store/);

  // Chat round trip, kept between sessions
  assert.equal((await adv('POST', '/api/chat', { body: 'Hello founder' })).status, 200);
  assert.equal((await admin('GET', '/api/admin/chats/unread')).body.unread, 1);
  await admin('POST', `/api/admin/chats/${userId}`, { body: 'Hello advisor' });
  assert.equal((await adv('GET', '/api/chat/unread')).body.unread, 1);
  const thread = await adv('GET', '/api/chat?read=1');
  assert.deepEqual(thread.body.map((m) => m.sender), ['advisor', 'founder']);
  assert.equal((await adv('GET', '/api/chat/unread')).body.unread, 0);

  // Prices and investments value the holding
  await admin('POST', '/api/admin/prices', { on_date: '2026-01-01', price: 10, kind: 'actual' });
  await admin('POST', '/api/admin/prices', { on_date: '2028-01-01', price: 50, kind: 'projected' });
  await admin('POST', '/api/admin/investments', { user_id: userId, invested_on: '2026-01-05', amount: 100000, shares: 10000 });
  const pf = await adv('GET', '/api/member/portfolio');
  assert.equal(pf.body.totals.value, 100000);
  assert.equal(pf.body.totals.projected_value, 500000);

  // The window ends: access stops and the advisor asks again
  db.prepare('UPDATE users SET access_expires_at = ? WHERE id = ?').run(Date.now() - 1000, userId);
  const exp = await adv('GET', '/api/member/overview');
  assert.equal(exp.status, 403);
  assert.equal(exp.body.state, 'expired');
  const rr = await adv('POST', '/api/auth/request-renewal');
  assert.equal(rr.body.user.state, 'pending');
  assert.equal(rr.body.user.renewal_requested, true);
  const perm = await admin('POST', `/api/admin/users/${userId}/approve`, { type: 'permanent' });
  assert.equal(perm.body.access_type, 'permanent');
  assert.equal((await adv('GET', '/api/member/overview')).status, 200);

  // Revoking logs the advisor out at once
  await admin('POST', `/api/admin/users/${userId}/revoke`);
  assert.equal((await adv('GET', '/api/member/overview')).status, 401);
  assert.equal((await adv('POST', '/api/auth/login', { uid, password: 'Secret123' })).status, 403);
});

test('anonymous visitors only see public pages and public news', async () => {
  const anon = client();
  assert.equal((await anon('GET', '/api/files/doc/1/raw')).status, 401);
  assert.equal((await anon('GET', '/api/admin/users')).status, 403);
  assert.equal((await anon('GET', '/api/member/overview')).status, 401);
  const admin = client();
  await admin('POST', '/api/auth/login', { uid: 'admin', password: 'Vinc@2026' });
  await admin('POST', '/api/admin/news', { title: 'Members only', body: 'secret', visibility: 'members' });
  await admin('POST', '/api/admin/news', { title: 'Public', body: 'hello', visibility: 'public' });
  const news = await anon('GET', '/api/auth/news');
  assert.deepEqual(news.body.map((n) => n.title), ['Public']);
});
