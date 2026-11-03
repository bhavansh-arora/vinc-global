'use strict';
const express = require('express');
const { db, getSettings } = require('./db');
const A = require('./auth');
const up = require('./uploads');
const notify = require('./notify');

const r = express.Router();
r.use(A.requireMember);

const KYC_TYPES = ['PAN card', 'Aadhaar card', 'Passport', 'Address proof', 'Bank proof / cancelled cheque', 'Photograph', 'Other'];

function docsFor(userId) {
  return db.prepare(`SELECT id, title, description, category, kind, original_name, size, url, created_at,
                            CASE WHEN audience_user_id IS NULL THEN 0 ELSE 1 END AS personal
                     FROM documents WHERE audience_user_id IS NULL OR audience_user_id = ?
                     ORDER BY created_at DESC`).all(userId);
}

function portfolio(userId) {
  const s = getSettings();
  const investments = db.prepare('SELECT id, invested_on, amount, shares, round, note FROM investments WHERE user_id = ? ORDER BY invested_on').all(userId);
  const prices = db.prepare('SELECT on_date, price, kind, note FROM share_prices ORDER BY on_date, id').all();
  const actual = prices.filter((p) => p.kind === 'actual');
  const projected = prices.filter((p) => p.kind === 'projected');
  const latest = actual[actual.length - 1] || null;
  const lastUpdate = db.prepare("SELECT MAX(created_at) AS t FROM share_prices WHERE kind = 'actual'").get().t;
  const target = projected[projected.length - 1] || null;
  const invested = investments.reduce((a, i) => a + i.amount, 0);
  const shares = investments.reduce((a, i) => a + i.shares, 0);
  const value = latest ? shares * latest.price : null;
  return {
    currency: s.currency,
    investments,
    certificates: db.prepare('SELECT id, title, certificate_no, original_name, size, created_at FROM certificates WHERE user_id = ? ORDER BY created_at DESC').all(userId),
    prices: { actual, projected, latest, target, updated_at: lastUpdate },
    totals: {
      invested, shares,
      avg_price: shares ? invested / shares : null,
      value,
      gain: value == null ? null : value - invested,
      projected_value: target ? shares * target.price : null,
    },
  };
}

r.get('/overview', (req, res) => {
  const u = req.user;
  const unread = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE advisor_id = ? AND sender = 'founder' AND read_at IS NULL").get(u.id).n;
  const kyc = db.prepare('SELECT status, COUNT(*) AS n FROM kyc_docs WHERE user_id = ? GROUP BY status').all(u.id);
  res.json({
    user: A.publicUser(u),
    news: db.prepare('SELECT id, title, body, tag, pinned, visibility, created_at FROM news ORDER BY pinned DESC, created_at DESC LIMIT 30').all(),
    documents: docsFor(u.id),
    unread,
    kyc,
    log: db.prepare('SELECT action, detail, at FROM access_log WHERE user_id = ? ORDER BY at DESC LIMIT 12').all(u.id),
    portfolio: portfolio(u.id),
    agreements: (() => {
      const AGM = require('./agreements');
      AGM.ensureFor(u);
      return db.prepare("SELECT kind, status FROM agreements WHERE user_id = ? AND status != 'void'").all(u.id)
        .map((a) => ({ kind: a.kind, title: AGM.KINDS[a.kind].title, status: a.status }));
    })(),
  });
});

r.get('/documents', (req, res) => res.json(docsFor(req.user.id)));
r.get('/portfolio', (req, res) => res.json(portfolio(req.user.id)));

// The "live" price: the most recent actual price the admin has published. The page polls this.
r.get('/price', (_req, res) => {
  const latest = db.prepare("SELECT on_date, price, created_at FROM share_prices WHERE kind = 'actual' ORDER BY on_date DESC, id DESC LIMIT 1").get();
  const prev = db.prepare("SELECT price FROM share_prices WHERE kind = 'actual' ORDER BY on_date DESC, id DESC LIMIT 1 OFFSET 1").get();
  res.json({ latest: latest || null, previous: prev ? prev.price : null, currency: getSettings().currency });
});

r.get('/kyc', (req, res) => {
  res.json({ types: KYC_TYPES, docs: db.prepare('SELECT id, doc_type, original_name, mime, size, status, remark, uploaded_at, reviewed_at FROM kyc_docs WHERE user_id = ? ORDER BY uploaded_at DESC').all(req.user.id) });
});

r.post('/kyc', up.single('kyc'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a file to upload.' });
  const type = KYC_TYPES.includes(req.body.doc_type) ? req.body.doc_type : 'Other';
  db.prepare('INSERT INTO kyc_docs (user_id, doc_type, stored_name, original_name, mime, size, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, type, req.file.filename, req.file.originalname.slice(0, 200), req.file.vgMime, req.file.size, Date.now());
  A.logAccess(req.user.id, 'kyc_uploaded', type);
  notify.adminKycUploaded(req.user, type);
  res.json({ ok: true });
});

// "Email me about updates" (news, documents, share price, founder replies).
r.patch('/prefs', (req, res) => {
  db.prepare('UPDATE users SET email_updates = ? WHERE id = ?').run(req.body.email_updates ? 1 : 0, req.user.id);
  res.json(A.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)));
});

r.delete('/kyc/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM kyc_docs WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!d) return res.status(404).json({ error: 'Not found.' });
  if (d.status === 'verified') return res.status(400).json({ error: 'Verified documents cannot be removed. Ask the VINC team if something changed.' });
  db.prepare('DELETE FROM kyc_docs WHERE id = ?').run(d.id);
  up.removeStored(d.stored_name);
  res.json({ ok: true });
});

module.exports = { router: r, portfolio, KYC_TYPES };
