'use strict';
// Email flows, rendered with a JSON transport (nothing leaves the machine): node --test test/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'vinc-global-mail-'));
process.env.DATA_DIR = DATA;
process.env.MAIL_TRANSPORT = 'json';
process.env.ADMIN_EMAIL = 'founder@example.com';
process.env.PUBLIC_URL = 'https://vinc-global.test';
const app = require('../server/index.js');
const mail = require('../server/mailer.js');

let server, base;
before(async () => { server = app.listen(0); await new Promise((r) => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.close(); fs.rmSync(DATA, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const mails = () => mail.sent.splice(0);
const settle = async () => { await new Promise((r) => setTimeout(r, 30)); await mail.drain(); };

test('ID, approval, updates and requests all send the right emails', async () => {
  const admin = client(), adv = client(), visitor = client();
  await admin('POST', '/api/auth/login', { uid: 'admin', password: 'Vinc@2026' });

  // New ID with an email: the VINC ID and sign-up link are emailed
  const gen = await admin('POST', '/api/admin/users', { role: 'investor', name: 'Ravi Kumar', email: 'ravi@example.com' });
  assert.equal(gen.body.emailed, true);
  await settle();
  let m = mails();
  assert.equal(m.length, 1);
  assert.equal(m[0].to, 'ravi@example.com');
  assert.match(m[0].subject, new RegExp(gen.body.uid));
  assert.match(m[0].text, new RegExp(`https://vinc-global.test/signup\\?uid=${gen.body.uid}`));

  // Sign-up tells the admin
  await adv('POST', '/api/auth/signup', { uid: gen.body.uid, name: 'Ravi Kumar', email: 'ravi@example.com', password: 'Secret123' });
  await settle();
  m = mails();
  assert.deepEqual(m.map((x) => x.to), ['founder@example.com']);
  assert.match(m[0].subject, /waiting for approval/);

  // Approval emails the member
  await admin('POST', `/api/admin/users/${gen.body.id}/approve`, { type: 'permanent' });
  await settle();
  m = mails();
  assert.equal(m.length, 1);
  assert.equal(m[0].kind, 'approved');
  assert.match(m[0].subject, /permanent access/);

  // Updates reach active members: news, share price, founder reply
  await admin('POST', '/api/admin/news', { title: 'Centre opens', body: 'Doors open on Saturday.', visibility: 'members' });
  await admin('POST', '/api/admin/prices', { on_date: '2026-11-01', price: 25, kind: 'actual' });
  await admin('POST', '/api/admin/prices', { on_date: '2025-01-01', price: 10, kind: 'actual' }); // back-fill: no email
  await admin('POST', `/api/admin/chats/${gen.body.id}`, { body: 'Thanks for joining!' });
  await admin('POST', `/api/admin/chats/${gen.body.id}`, { body: 'One more thing.' });                // throttled
  await settle();
  m = mails();
  assert.deepEqual(m.map((x) => x.kind).sort(), ['chat', 'news', 'price']);

  // Members can turn update emails off; account emails still go out
  await adv('PATCH', '/api/member/prefs', { email_updates: false });
  await admin('POST', '/api/admin/news', { title: 'Second update', body: 'More news.', visibility: 'members' });
  await admin('POST', '/api/admin/investments', { user_id: gen.body.id, invested_on: '2026-11-02', amount: 50000, shares: 2000 });
  await settle();
  m = mails();
  assert.deepEqual(m.map((x) => x.kind), ['investment']);

  // Public "Request a VINC ID": acknowledgement + admin notice; then the admin turns it into an ID
  const bad = await visitor('POST', '/api/auth/request-id', { name: 'X', email: 'not-an-email' });
  assert.equal(bad.status, 400);
  const bot = await visitor('POST', '/api/auth/request-id', { name: 'Bot', email: 'bot@example.com', website: 'http://spam' });
  assert.equal(bot.status, 200);
  const ok = await visitor('POST', '/api/auth/request-id', { name: 'Neha Gupta', email: 'neha@example.com', organisation: 'Gupta Family Office', role: 'investor', message: 'Keen to support', elapsed: 9000 });
  assert.equal(ok.status, 200);
  await settle();
  m = mails();
  assert.deepEqual(m.map((x) => x.to).sort(), ['founder@example.com', 'neha@example.com']);
  const reqs = await admin('GET', '/api/admin/requests');
  assert.equal(reqs.body.length, 1, 'the honeypot request was not stored');
  assert.equal((await admin('GET', '/api/admin/stats')).body.requests, 1);
  const made = await admin('POST', `/api/admin/requests/${reqs.body[0].id}/approve`, {});
  assert.match(made.body.uid, /^VG-INV-/);
  assert.equal(made.body.organisation, 'Gupta Family Office');
  await settle();
  m = mails();
  assert.equal(m.length, 1);
  assert.equal(m[0].to, 'neha@example.com');
  assert.match(m[0].text, new RegExp(made.body.uid));
  assert.equal((await admin('POST', `/api/admin/requests/${reqs.body[0].id}/approve`, {})).status, 400);

  // Every email is in the admin's log
  const log = await admin('GET', '/api/admin/email');
  assert.ok(log.body.log.length >= 9);
  assert.ok(log.body.log.every((l) => l.status === 'sent'));
});
