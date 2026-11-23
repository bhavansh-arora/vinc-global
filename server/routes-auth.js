'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, getSettings } = require('./db');
const A = require('./auth');
const notify = require('./notify');
const mail = require('./mailer');

const r = express.Router();

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function passwordProblem(p) {
  if (typeof p !== 'string' || p.length < 8) return 'Use at least 8 characters for the password.';
  if (p.length > 128) return 'That password is too long.';
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return 'Use both letters and numbers in the password.';
  return null;
}

function publicSettings() {
  const s = getSettings();
  return { company_name: s.company_name, founder_name: s.founder_name, currency: s.currency, contact_email: s.contact_email, temp_access_hours: Number(s.temp_access_hours) || 72 };
}

r.get('/settings', (_req, res) => res.json(publicSettings()));

const NEWS_COLS = "id, title, body, tag, pinned, visibility, created_at, file_name, file_mime, file_size, CASE WHEN file_stored IS NULL THEN 0 ELSE 1 END AS has_file";

r.get('/news', (_req, res) => {
  res.json(db.prepare(`SELECT ${NEWS_COLS} FROM news WHERE visibility = 'public' ORDER BY pinned DESC, created_at DESC LIMIT 6`).all());
});

// The PDF or image published with a news post. Public posts are open to everyone; members-only posts need
// an active member (or the admin). Shown inline, never cached.
r.get('/news/:id/file', (req, res) => {
  const n = db.prepare('SELECT * FROM news WHERE id = ?').get(req.params.id);
  const ok = n && n.file_stored && (n.visibility === 'public' || (req.user && (req.user.role === 'admin' || A.accessState(req.user) === 'active')));
  if (!ok) return res.status(404).json({ error: 'Not found.' });
  const fs = require('node:fs');
  const p = require('./uploads').storedPath(n.file_stored);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File missing on the server.' });
  const safe = (n.file_name || 'attachment').replace(/[^\w.\- ]+/g, '_');
  res.setHeader('Content-Type', n.file_mime || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `inline; filename="${safe}"`);
  fs.createReadStream(p).pipe(res);
});

r.get('/me', (req, res) => res.json({ user: A.publicUser(req.user), settings: publicSettings() }));

r.post('/login', A.rateLimit, (req, res) => {
  const uid = str(req.body.uid, 64);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const u = uid && db.prepare('SELECT * FROM users WHERE uid = ?').get(uid);
  if (u && u.status === 'invited') return res.status(400).json({ error: 'This ID has not been activated yet. Please sign up first.', code: 'signup' });
  if (!u || !u.password_hash || !bcrypt.compareSync(password, u.password_hash)) {
    return res.status(401).json({ error: 'The ID or password is not right.' });
  }
  if (u.status === 'rejected') return res.status(403).json({ error: 'This sign-up was not approved. Please contact the VINC team.' });
  if (u.status === 'revoked') return res.status(403).json({ error: 'Access for this ID has been withdrawn. Please contact the VINC team.' });
  A.clearRateLimit(req);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), u.id);
  A.createSession(res, u.id);
  A.logAccess(u.id, 'login');
  res.json({ user: A.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

r.post('/signup', A.rateLimit, (req, res) => {
  const uid = str(req.body.uid, 64);
  const name = str(req.body.name, 120);
  const email = str(req.body.email, 160);
  const phone = str(req.body.phone, 40);
  const organisation = str(req.body.organisation, 160);
  const password = req.body.password;
  if (!uid) return res.status(400).json({ error: 'Enter the ID the VINC team shared with you.' });
  if (!name) return res.status(400).json({ error: 'Enter your full name.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });
  const u = db.prepare('SELECT * FROM users WHERE uid = ?').get(uid);
  if (!u || !A.isMember(u)) return res.status(404).json({ error: 'We could not find that ID. Check it with the VINC team.' });
  if (u.status !== 'invited') return res.status(409).json({ error: 'This ID is already signed up. Please log in instead.' });
  db.prepare(`UPDATE users SET name = ?, email = ?, phone = ?, organisation = ?, password_hash = ?, status = 'pending', signup_at = ?, renewal_requested = 0 WHERE id = ?`)
    .run(name, email, phone, organisation, bcrypt.hashSync(password, 10), Date.now(), u.id);
  A.logAccess(u.id, 'signup');
  notify.adminSignup(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id), false);
  A.clearRateLimit(req);
  A.createSession(res, u.id);
  res.json({ user: A.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

r.post('/logout', (req, res) => { A.destroySession(req, res); res.json({ ok: true }); });

// After a temporary window ends, the member asks for access again. It goes back to the admin's queue.
r.post('/request-renewal', A.requireAuth, (req, res) => {
  const u = req.user;
  if (!A.isMember(u)) return res.status(400).json({ error: 'Not needed for this account.' });
  const state = A.accessState(u);
  if (state !== 'expired') return res.status(400).json({ error: 'Your access does not need renewing right now.' });
  db.prepare("UPDATE users SET status = 'pending', renewal_requested = 1 WHERE id = ?").run(u.id);
  A.logAccess(u.id, 'renewal_requested');
  notify.adminSignup(u, true);
  res.json({ user: A.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

// Public "Request a VINC ID" form. Spam guards: the form must have been open for a few seconds (sent by
// the page's script, so scripted posts without it are dropped), a per-IP limit, and one open request per email.
const reqHits = new Map();
r.post('/request-id', (req, res) => {
  const b = req.body || {};
  if (!(Number(b.elapsed) >= 2500)) return res.json({ ok: true });   // looks automated: accept quietly, store nothing
  const now = Date.now();
  const hits = (reqHits.get(req.ip) || []).filter((t) => t > now - 3600000);
  if (hits.length >= 5) return res.status(429).json({ error: 'Too many requests from your connection. Please try again later.' });
  const name = str(b.name, 120), email = str(b.email, 160);
  if (!name) return res.status(400).json({ error: 'Please enter your name.' });
  if (!mail.isEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  hits.push(now); reqHits.set(req.ip, hits);
  const open = db.prepare("SELECT id FROM id_requests WHERE lower(email) = lower(?) AND status = 'new'").get(email);
  const existing = db.prepare("SELECT id FROM users WHERE lower(email) = lower(?) AND role IN ('advisor','investor')").get(email);
  if (open || existing) return res.json({ ok: true });               // already with the team; don't reveal more
  const row = { name, email, phone: str(b.phone, 40) || null, organisation: str(b.organisation, 160) || null,
    role: b.role === 'investor' ? 'investor' : 'advisor', message: str(b.message, 1500) || null };
  db.prepare('INSERT INTO id_requests (name, email, phone, organisation, role, message, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.name, row.email, row.phone, row.organisation, row.role, row.message, req.ip, now);
  notify.idRequested(row);
  res.json({ ok: true });
});

r.post('/password', A.requireAuth, (req, res) => {
  const { current, next } = req.body || {};
  if (!bcrypt.compareSync(String(current || ''), req.user.password_hash || '')) return res.status(400).json({ error: 'Your current password is not right.' });
  const problem = passwordProblem(next);
  if (problem) return res.status(400).json({ error: problem });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, 10), req.user.id);
  A.logAccess(req.user.id, 'password_changed');
  res.json({ ok: true });
});

module.exports = { NEWS_COLS, router: r, passwordProblem, str };
