'use strict';
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, getSettings, tx } = require('./db');
const A = require('./auth');
const up = require('./uploads');
const { passwordProblem, str } = require('./routes-auth');
const notify = require('./notify');
const mail = require('./mailer');

const r = express.Router();
r.use(A.requireAdmin);

const CATEGORIES = ['board_resolutions', 'registration', 'financials', 'reports', 'legal', 'general'];
const HOUR = 3600 * 1000;

const userRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const memberOr404 = (req, res) => {
  const u = userRow(Number(req.params.id));
  if (!u || u.role === 'admin') { res.status(404).json({ error: 'Member not found.' }); return null; }
  return u;
};

function newUid(role) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const prefix = role === 'investor' ? 'VG-INV-' : 'VG-ADV-';
  for (;;) {
    const bytes = crypto.randomBytes(6);
    let s = '';
    for (const b of bytes) s += alphabet[b % alphabet.length];
    const uid = prefix + s;
    if (!db.prepare('SELECT 1 FROM users WHERE uid = ?').get(uid)) return uid;
  }
}

function grant(u, type, hours) {
  const now = Date.now();
  const h = Number(hours) > 0 ? Math.min(Number(hours), 24 * 365) : A.tempHours();
  const expires = type === 'temporary' ? now + h * HOUR : null;
  db.prepare(`UPDATE users SET status = 'active', access_type = ?, access_expires_at = ?, approved_at = ?, renewal_requested = 0 WHERE id = ?`)
    .run(type, expires, now, u.id);
  A.logAccess(u.id, type === 'temporary' ? 'approved_temporary' : 'approved_permanent', type === 'temporary' ? `${h} hours` : null);
}

// ---------- overview ----------
r.get('/stats', (_req, res) => {
  const now = Date.now();
  const one = (sql, ...p) => db.prepare(sql).get(...p).n;
  res.json({
    members: one("SELECT COUNT(*) AS n FROM users WHERE role != 'admin'"),
    advisors: one("SELECT COUNT(*) AS n FROM users WHERE role = 'advisor'"),
    investors: one("SELECT COUNT(*) AS n FROM users WHERE role = 'investor'"),
    pending: one("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'"),
    invited: one("SELECT COUNT(*) AS n FROM users WHERE status = 'invited'"),
    active_temp: one("SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND access_type = 'temporary' AND access_expires_at > ?", now),
    active_perm: one("SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND access_type = 'permanent' AND role != 'admin'"),
    kyc_pending: one("SELECT COUNT(*) AS n FROM kyc_docs WHERE status = 'submitted'"),
    requests: one("SELECT COUNT(*) AS n FROM id_requests WHERE status = 'new'"),
    agreements_to_sign: one("SELECT COUNT(*) AS n FROM agreements WHERE status = 'member_signed'"),
    unread: one("SELECT COUNT(*) AS n FROM messages WHERE sender = 'advisor' AND read_at IS NULL"),
    documents: one('SELECT COUNT(*) AS n FROM documents'),
    news: one('SELECT COUNT(*) AS n FROM news'),
    invested: db.prepare('SELECT COALESCE(SUM(amount),0) AS n FROM investments').get().n,
    recent: db.prepare(`SELECT l.action, l.detail, l.at, u.uid, u.name FROM access_log l JOIN users u ON u.id = l.user_id
                        WHERE u.role != 'admin' ORDER BY l.at DESC LIMIT 15`).all(),
  });
});

// ---------- members ----------
r.get('/users', (_req, res) => {
  const rows = db.prepare(`SELECT u.*,
      (SELECT COUNT(*) FROM kyc_docs k WHERE k.user_id = u.id) AS kyc_count,
      (SELECT COUNT(*) FROM kyc_docs k WHERE k.user_id = u.id AND k.status = 'submitted') AS kyc_pending,
      (SELECT COALESCE(SUM(amount),0) FROM investments i WHERE i.user_id = u.id) AS invested
    FROM users u WHERE u.role != 'admin' ORDER BY u.created_at DESC`).all();
  res.json(rows.map((u) => ({ ...A.publicUser(u), notes: u.notes, kyc_count: u.kyc_count, kyc_pending: u.kyc_pending, invested: u.invested })));
});

r.post('/users', (req, res) => {
  const role = req.body.role === 'investor' ? 'investor' : 'advisor';
  let uid = str(req.body.uid, 40).toUpperCase();
  if (uid) {
    if (!/^[A-Z0-9][A-Z0-9-]{3,39}$/.test(uid)) return res.status(400).json({ error: 'Custom IDs use letters, numbers and dashes (4–40 characters).' });
    if (uid === 'ADMIN' || db.prepare('SELECT 1 FROM users WHERE uid = ?').get(uid)) return res.status(409).json({ error: 'That ID is already taken.' });
  } else uid = newUid(role);
  const name = str(req.body.name, 120) || null;
  const email = str(req.body.email, 160) || null;
  const password = req.body.password ? String(req.body.password) : '';
  const access = ['temporary', 'permanent'].includes(req.body.access) ? req.body.access : null;
  if (password) {
    const p = passwordProblem(password);
    if (p) return res.status(400).json({ error: p });
  }
  if (access && !password) return res.status(400).json({ error: 'Set a starting password to pre-approve access, or leave access empty so the member signs up.' });
  const now = Date.now();
  const info = db.prepare(`INSERT INTO users (uid, role, name, email, notes, password_hash, status, signup_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uid, role, name, email, str(req.body.notes, 500) || null, password ? bcrypt.hashSync(password, 10) : null, password ? 'pending' : 'invited', password ? now : null, now);
  const u = userRow(info.lastInsertRowid);
  A.logAccess(u.id, 'id_generated', role);
  if (access) grant(u, access, req.body.hours);
  const fresh = userRow(u.id);
  const emailed = fresh.email ? (password ? notify.loginReady(fresh) : notify.invitation(fresh)) : false;
  res.json({ ...A.publicUser(fresh), emailed, email_configured: mail.status().configured });
});

r.get('/users/:id', (req, res) => {
  const u = memberOr404(req, res); if (!u) return;
  res.json({
    user: { ...A.publicUser(u), notes: u.notes },
    kyc: db.prepare('SELECT id, doc_type, original_name, mime, size, status, remark, uploaded_at, reviewed_at FROM kyc_docs WHERE user_id = ? ORDER BY uploaded_at DESC').all(u.id),
    investments: db.prepare('SELECT * FROM investments WHERE user_id = ? ORDER BY invested_on').all(u.id),
    certificates: db.prepare('SELECT id, title, certificate_no, original_name, mime, size, created_at FROM certificates WHERE user_id = ? ORDER BY created_at DESC').all(u.id),
    log: db.prepare('SELECT action, detail, at FROM access_log WHERE user_id = ? ORDER BY at DESC LIMIT 40').all(u.id),
  });
});

r.patch('/users/:id', (req, res) => {
  const u = memberOr404(req, res); if (!u) return;
  const f = (k, max) => (req.body[k] === undefined ? u[k] : str(req.body[k], max) || null);
  const role = req.body.role === 'investor' || req.body.role === 'advisor' ? req.body.role : u.role;
  db.prepare('UPDATE users SET name = ?, email = ?, phone = ?, organisation = ?, notes = ?, role = ? WHERE id = ?')
    .run(f('name', 120), f('email', 160), f('phone', 40), f('organisation', 160), f('notes', 500), role, u.id);
  res.json(A.publicUser(userRow(u.id)));
});

// Email the VINC ID again (or the "login ready" note when a password was set for them).
r.post('/users/:id/invite', (req, res) => {
  const u = memberOr404(req, res); if (!u) return;
  if (!mail.isEmail(u.email || '')) return res.status(400).json({ error: 'Add an email address for this member first.' });
  const ok = u.status === 'invited' ? notify.invitation(u) : notify.loginReady(u);
  res.json({ ok, configured: mail.status().configured });
});

r.post('/users/:id/approve', (req, res) => {
  const u = memberOr404(req, res); if (!u) return;
  if (!u.password_hash) return res.status(400).json({ error: 'This member has not signed up yet.' });
  const type = req.body.type === 'permanent' ? 'permanent' : 'temporary';
  grant(u, type, req.body.hours);
  const fresh = userRow(u.id);
  notify.approved(fresh);
  // Ask them to sign their onboarding agreement, if it is ready and not yet signed.
  const AGM = require('./agreements');
  AGM.ensureRole(fresh, 'Admin');
  const toSign = db.prepare("SELECT * FROM agreements WHERE user_id = ? AND status = 'pending' AND mandatory = 1").all(fresh.id);
  if (toSign.length) notify.agreementReady(fresh, toSign.map((a) => AGM.titleOf(a)).join(' and '));
  res.json(A.publicUser(fresh));
});

r.post('/users/:id/reject', (req, res) => {
  const u = memberOr404(req, res); if (!u) return;
  db.prepare("UPDATE users SET status = 'rejected', renewal_requested = 0 WHERE id = ?").run(u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  A.logAccess(u.id, 'rejected');
  res.json(A.publicUser(userRow(u.id)));
});

r.post('/users/:id/revoke', (req, res) => {
  const u = memberOr404(req, res); if (!u) return;
  db.prepare("UPDATE users SET status = 'revoked', access_expires_at = NULL WHERE id = ?").run(u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  A.logAccess(u.id, 'revoked');
  res.json(A.publicUser(userRow(u.id)));
});

// Back to "invited": clears the password so the member signs up again with the same ID.
r.post('/users/:id/reset', (req, res) => {
  const u = memberOr404(req, res); if (!u) return;
  db.prepare("UPDATE users SET status = 'invited', password_hash = NULL, access_type = NULL, access_expires_at = NULL, renewal_requested = 0 WHERE id = ?").run(u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  A.logAccess(u.id, 'reset');
  res.json(A.publicUser(userRow(u.id)));
});

r.delete('/users/:id', (req, res) => {
  const u = memberOr404(req, res); if (!u) return;
  const files = [
    ...db.prepare('SELECT stored_name FROM kyc_docs WHERE user_id = ?').all(u.id),
    ...db.prepare('SELECT stored_name FROM certificates WHERE user_id = ?').all(u.id),
    ...db.prepare('SELECT stored_name FROM documents WHERE audience_user_id = ? AND stored_name IS NOT NULL').all(u.id),
    ...db.prepare('SELECT member_sig AS stored_name FROM agreements WHERE user_id = ? AND member_sig IS NOT NULL').all(u.id),
    ...db.prepare('SELECT executed_name AS stored_name FROM agreements WHERE user_id = ? AND executed_name IS NOT NULL').all(u.id),
  ];
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  files.forEach((f) => up.removeStored(f.stored_name));
  res.json({ ok: true });
});

// ---------- news ----------
r.get('/news', (_req, res) => res.json(db.prepare('SELECT * FROM news ORDER BY pinned DESC, created_at DESC').all()));
r.post('/news', (req, res) => {
  const title = str(req.body.title, 200), body = str(req.body.body, 8000);
  if (!title || !body) return res.status(400).json({ error: 'Add a title and the news text.' });
  const vis = req.body.visibility === 'public' ? 'public' : 'members';
  const info = db.prepare('INSERT INTO news (title, body, tag, visibility, pinned, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(title, body, str(req.body.tag, 40) || null, vis, req.body.pinned ? 1 : 0, Date.now());
  const row = db.prepare('SELECT * FROM news WHERE id = ?').get(info.lastInsertRowid);
  if (req.body.notify !== false) notify.newsPublished(row);
  res.json(row);
});
r.patch('/news/:id', (req, res) => {
  const n = db.prepare('SELECT * FROM news WHERE id = ?').get(req.params.id);
  if (!n) return res.status(404).json({ error: 'Not found.' });
  db.prepare('UPDATE news SET pinned = ?, visibility = ? WHERE id = ?')
    .run(req.body.pinned === undefined ? n.pinned : (req.body.pinned ? 1 : 0), ['public', 'members'].includes(req.body.visibility) ? req.body.visibility : n.visibility, n.id);
  res.json(db.prepare('SELECT * FROM news WHERE id = ?').get(n.id));
});
r.delete('/news/:id', (req, res) => { db.prepare('DELETE FROM news WHERE id = ?').run(req.params.id); res.json({ ok: true }); });

// ---------- documents (PDF, Excel or link; all view only) ----------
r.get('/documents', (_req, res) => {
  res.json(db.prepare(`SELECT d.id, d.title, d.description, d.category, d.kind, d.original_name, d.size, d.url, d.created_at, d.audience_user_id, d.link_frameable, d.link_reason,
                              u.uid AS audience_uid, u.name AS audience_name
                       FROM documents d LEFT JOIN users u ON u.id = d.audience_user_id ORDER BY d.created_at DESC`).all());
});

r.post('/documents', up.single((req) => (req.body.kind === 'excel' ? 'excel' : 'pdf')), async (req, res) => {
  const kind = ['pdf', 'excel', 'link'].includes(req.body.kind) ? req.body.kind : null;
  const cleanup = () => req.file && up.removeStored(req.file.filename);
  const title = str(req.body.title, 200);
  if (!kind) { cleanup(); return res.status(400).json({ error: 'Choose PDF, Excel or link.' }); }
  if (!title) { cleanup(); return res.status(400).json({ error: 'Give the document a title.' }); }
  const category = CATEGORIES.includes(req.body.category) ? req.body.category : 'general';
  let audience = req.body.audience_user_id ? Number(req.body.audience_user_id) : null;
  if (audience && !db.prepare("SELECT 1 FROM users WHERE id = ? AND role != 'admin'").get(audience)) audience = null;
  let url = null;
  if (kind === 'link') {
    cleanup();
    try {
      const u = new URL(str(req.body.url, 2000));
      if (!['https:', 'http:'].includes(u.protocol)) throw new Error();
      url = u.toString();
    } catch { return res.status(400).json({ error: 'Enter a full web address starting with https://' }); }
  } else if (!req.file) return res.status(400).json({ error: 'Choose a file to upload.' });
  const info = db.prepare(`INSERT INTO documents (title, description, category, kind, stored_name, original_name, mime, size, url, audience_user_id, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(title, str(req.body.description, 1000) || null, category, kind,
      req.file ? req.file.filename : null, req.file ? req.file.originalname.slice(0, 200) : null,
      req.file ? req.file.vgMime : null, req.file ? req.file.size : null, url, audience, Date.now());
  notify.documentPublished(db.prepare('SELECT * FROM documents WHERE id = ?').get(info.lastInsertRowid));
  let link = null;
  if (kind === 'link') {
    // Find out now whether the site can be shown inside the portal, so the admin knows straight away.
    link = await require('./links').check(url);
    db.prepare('UPDATE documents SET link_embed = ?, link_frameable = ?, link_reason = ?, link_checked_at = ? WHERE id = ?')
      .run(link.embed_url, link.frameable == null ? null : (link.frameable ? 1 : 0), link.reason, Date.now(), info.lastInsertRowid);
    link.message = link.reason ? require('./links').REASONS[link.reason] : null;
  }
  res.json({ id: Number(info.lastInsertRowid), link });
});

r.delete('/documents/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found.' });
  db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
  up.removeStored(d.stored_name);
  res.json({ ok: true });
});

// ---------- KYC ----------
r.get('/kyc', (_req, res) => {
  res.json(db.prepare(`SELECT k.id, k.doc_type, k.original_name, k.mime, k.size, k.status, k.remark, k.uploaded_at, k.reviewed_at, u.id AS user_id, u.uid, u.name
                       FROM kyc_docs k JOIN users u ON u.id = k.user_id ORDER BY (k.status = 'submitted') DESC, k.uploaded_at DESC`).all());
});
r.post('/kyc/:id/review', (req, res) => {
  const k = db.prepare('SELECT * FROM kyc_docs WHERE id = ?').get(req.params.id);
  if (!k) return res.status(404).json({ error: 'Not found.' });
  const status = ['verified', 'rejected', 'submitted'].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'Choose verified or rejected.' });
  db.prepare('UPDATE kyc_docs SET status = ?, remark = ?, reviewed_at = ? WHERE id = ?').run(status, str(req.body.remark, 300) || null, Date.now(), k.id);
  A.logAccess(k.user_id, 'kyc_' + status, k.doc_type);
  if (status !== 'submitted') notify.kycReviewed(userRow(k.user_id), { ...k, status, remark: str(req.body.remark, 300) || null });
  res.json({ ok: true });
});

// ---------- investments & certificates ----------
r.get('/investments', (_req, res) => {
  res.json({
    investments: db.prepare(`SELECT i.*, u.uid, u.name FROM investments i JOIN users u ON u.id = i.user_id ORDER BY i.invested_on DESC, i.id DESC`).all(),
    certificates: db.prepare(`SELECT c.id, c.title, c.certificate_no, c.original_name, c.mime, c.size, c.created_at, c.user_id, u.uid, u.name
                              FROM certificates c JOIN users u ON u.id = c.user_id ORDER BY c.created_at DESC`).all(),
  });
});
r.post('/investments', (req, res) => {
  const userId = Number(req.body.user_id);
  if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role != 'admin'").get(userId)) return res.status(400).json({ error: 'Choose a member.' });
  const amount = Number(req.body.amount), shares = Number(req.body.shares);
  const on = str(req.body.invested_on, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) return res.status(400).json({ error: 'Choose the investment date.' });
  if (!(amount > 0) || !(shares > 0)) return res.status(400).json({ error: 'Amount and shares must be more than zero.' });
  db.prepare('INSERT INTO investments (user_id, invested_on, amount, shares, round, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, on, amount, shares, str(req.body.round, 80) || null, str(req.body.note, 300) || null, Date.now());
  A.logAccess(userId, 'investment_recorded', `${amount}`);
  notify.investmentRecorded(userRow(userId), { invested_on: on, amount, shares, round: str(req.body.round, 80) || null });
  res.json({ ok: true });
});
r.delete('/investments/:id', (req, res) => { db.prepare('DELETE FROM investments WHERE id = ?').run(req.params.id); res.json({ ok: true }); });

r.post('/certificates', up.single('certificate'), (req, res) => {
  const userId = Number(req.body.user_id);
  const cleanup = () => req.file && up.removeStored(req.file.filename);
  if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role != 'admin'").get(userId)) { cleanup(); return res.status(400).json({ error: 'Choose a member.' }); }
  if (!req.file) return res.status(400).json({ error: 'Choose the certificate file (PDF or image).' });
  db.prepare('INSERT INTO certificates (user_id, title, certificate_no, stored_name, original_name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(userId, str(req.body.title, 200) || 'Share certificate', str(req.body.certificate_no, 60) || null, req.file.filename, req.file.originalname.slice(0, 200), req.file.vgMime, req.file.size, Date.now());
  A.logAccess(userId, 'certificate_issued', str(req.body.certificate_no, 60) || null);
  notify.certificateIssued(userRow(userId), { title: str(req.body.title, 200) || 'Share certificate', certificate_no: str(req.body.certificate_no, 60) || null });
  res.json({ ok: true });
});
r.delete('/certificates/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM certificates WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found.' });
  db.prepare('DELETE FROM certificates WHERE id = ?').run(c.id);
  up.removeStored(c.stored_name);
  res.json({ ok: true });
});

// ---------- share price ----------
r.get('/prices', (_req, res) => res.json(db.prepare('SELECT * FROM share_prices ORDER BY on_date, id').all()));
r.post('/prices', (req, res) => {
  const on = str(req.body.on_date, 10), price = Number(req.body.price);
  const kind = req.body.kind === 'projected' ? 'projected' : 'actual';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) return res.status(400).json({ error: 'Choose a date.' });
  if (!(price > 0)) return res.status(400).json({ error: 'Price must be more than zero.' });
  db.prepare('INSERT INTO share_prices (on_date, price, kind, note, created_at) VALUES (?, ?, ?, ?, ?)').run(on, price, kind, str(req.body.note, 200) || null, Date.now());
  if (kind === 'actual') notify.priceUpdated({ on_date: on, price, note: str(req.body.note, 200) || null });
  res.json({ ok: true });
});
r.delete('/prices/:id', (req, res) => { db.prepare('DELETE FROM share_prices WHERE id = ?').run(req.params.id); res.json({ ok: true }); });

// ---------- settings ----------
const EDITABLE = ['company_name', 'founder_name', 'currency', 'temp_access_hours', 'contact_email'];
// ---------- VINC ID requests from the public site ----------
r.get('/requests', (_req, res) => {
  res.json(db.prepare(`SELECT r.id, r.name, r.email, r.phone, r.organisation, r.role, r.message, r.status, r.created_at, r.handled_at, r.user_id, u.uid
                       FROM id_requests r LEFT JOIN users u ON u.id = r.user_id ORDER BY (r.status = 'new') DESC, r.created_at DESC LIMIT 300`).all());
});
r.post('/requests/:id/approve', (req, res) => {
  const q = db.prepare('SELECT * FROM id_requests WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found.' });
  if (q.status !== 'new') return res.status(400).json({ error: 'This request has already been handled.' });
  if (db.prepare("SELECT 1 FROM users WHERE lower(email) = lower(?) AND role != 'admin'").get(q.email)) return res.status(409).json({ error: 'A member with this email already exists.' });
  const role = ['advisor', 'investor'].includes(req.body.role) ? req.body.role : q.role;
  const now = Date.now();
  const user = tx(() => {
    const info = db.prepare("INSERT INTO users (uid, role, name, email, phone, organisation, notes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'invited', ?)")
      .run(newUid(role), role, q.name, q.email, q.phone, q.organisation, q.message ? `Request: ${q.message}`.slice(0, 500) : null, now);
    db.prepare("UPDATE id_requests SET status = 'approved', user_id = ?, handled_at = ? WHERE id = ?").run(info.lastInsertRowid, now, q.id);
    return userRow(info.lastInsertRowid);
  });
  A.logAccess(user.id, 'id_generated', `${role} (from website request)`);
  const emailed = notify.invitation(user);
  res.json({ ...A.publicUser(user), emailed, email_configured: mail.status().configured });
});
r.post('/requests/:id/dismiss', (req, res) => {
  db.prepare("UPDATE id_requests SET status = 'dismissed', handled_at = ? WHERE id = ? AND status = 'new'").run(Date.now(), req.params.id);
  res.json({ ok: true });
});

// ---------- email ----------
r.get('/email', (_req, res) => {
  res.json({ ...mail.status(), log: db.prepare('SELECT to_addr, subject, kind, status, error, at FROM email_log ORDER BY id DESC LIMIT 40').all() });
});
r.post('/email/test', async (req, res) => {
  const to = str(req.body.to, 160) || mail.ADMIN_EMAIL;
  if (!mail.isEmail(to)) return res.status(400).json({ error: 'Enter an email address to send the test to.' });
  const check = await mail.verify();
  if (!check.ok) return res.status(502).json({ error: 'Could not connect to the mail server: ' + check.error });
  mail.send({ to, kind: 'test', subject: 'VINC Global test email', title: 'Email is working',
    lines: ['This is a test from VINC Global. If you can read this, members will receive their VINC IDs, approvals and updates by email.'] });
  res.json({ ok: true, to });
});

r.get('/settings', (_req, res) => res.json(getSettings()));
r.put('/settings', (req, res) => {
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  tx(() => {
    for (const k of EDITABLE) {
      if (req.body[k] === undefined) continue;
      let v = str(String(req.body[k]), 120);
      if (k === 'temp_access_hours') { const h = Math.round(Number(v)); if (!(h >= 1 && h <= 24 * 30)) continue; v = String(h); }
      if (v) set.run(k, v);
    }
  });
  res.json(getSettings());
});

module.exports = { router: r, CATEGORIES };
