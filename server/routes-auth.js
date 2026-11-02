'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, getSettings } = require('./db');
const A = require('./auth');

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

r.get('/news', (_req, res) => {
  res.json(db.prepare("SELECT id, title, body, tag, pinned, created_at FROM news WHERE visibility = 'public' ORDER BY pinned DESC, created_at DESC LIMIT 6").all());
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
  if (!u || u.role === 'admin') return res.status(404).json({ error: 'We could not find that ID. Check it with the VINC team.' });
  if (u.status !== 'invited') return res.status(409).json({ error: 'This ID is already signed up. Please log in instead.' });
  db.prepare(`UPDATE users SET name = ?, email = ?, phone = ?, organisation = ?, password_hash = ?, status = 'pending', signup_at = ?, renewal_requested = 0 WHERE id = ?`)
    .run(name, email, phone, organisation, bcrypt.hashSync(password, 10), Date.now(), u.id);
  A.logAccess(u.id, 'signup');
  A.clearRateLimit(req);
  A.createSession(res, u.id);
  res.json({ user: A.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

r.post('/logout', (req, res) => { A.destroySession(req, res); res.json({ ok: true }); });

// After a temporary window ends, the member asks for access again. It goes back to the admin's queue.
r.post('/request-renewal', A.requireAuth, (req, res) => {
  const u = req.user;
  if (u.role === 'admin') return res.status(400).json({ error: 'Not needed for admin.' });
  const state = A.accessState(u);
  if (state !== 'expired') return res.status(400).json({ error: 'Your access does not need renewing right now.' });
  db.prepare("UPDATE users SET status = 'pending', renewal_requested = 1 WHERE id = ?").run(u.id);
  A.logAccess(u.id, 'renewal_requested');
  res.json({ user: A.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
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

module.exports = { router: r, passwordProblem, str };
