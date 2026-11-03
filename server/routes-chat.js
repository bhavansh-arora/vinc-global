'use strict';
// "Ask the Founder": one conversation per advisor or investor, kept forever, answered by the admin.
const express = require('express');
const { db } = require('./db');
const A = require('./auth');
const notify = require('./notify');

const member = express.Router();
const admin = express.Router();
member.use(A.requireMember);
admin.use(A.requireAdmin);

const MAX = 4000;
const cleanBody = (b) => (typeof b === 'string' ? b.replace(/\r\n/g, '\n').trim().slice(0, MAX) : '');

function thread(advisorId, after) {
  return db.prepare('SELECT id, sender, body, created_at, read_at FROM messages WHERE advisor_id = ? AND id > ? ORDER BY id LIMIT 500')
    .all(advisorId, Number(after) || 0);
}

// ----- advisor side -----
member.get('/', (req, res) => {
  const msgs = thread(req.user.id, req.query.after);
  if (req.query.read === '1') {
    db.prepare("UPDATE messages SET read_at = ? WHERE advisor_id = ? AND sender = 'founder' AND read_at IS NULL").run(Date.now(), req.user.id);
  }
  res.json(msgs);
});
member.get('/unread', (req, res) => {
  res.json({ unread: db.prepare("SELECT COUNT(*) AS n FROM messages WHERE advisor_id = ? AND sender = 'founder' AND read_at IS NULL").get(req.user.id).n });
});
member.post('/', (req, res) => {
  const body = cleanBody(req.body.body);
  if (!body) return res.status(400).json({ error: 'Type a message first.' });
  const info = db.prepare("INSERT INTO messages (advisor_id, sender, body, created_at) VALUES (?, 'advisor', ?, ?)").run(req.user.id, body, Date.now());
  notify.adminNewMessage(req.user, body);
  res.json(db.prepare('SELECT id, sender, body, created_at, read_at FROM messages WHERE id = ?').get(info.lastInsertRowid));
});

// ----- founder (admin) side -----
// Every member the founder can talk to: anyone who has signed up (or already has messages),
// with the latest message, unread count and whether the last word was theirs (needs a reply).
admin.get('/', (_req, res) => {
  const rows = db.prepare(`
    SELECT u.*,
           (SELECT body FROM messages m WHERE m.advisor_id = u.id ORDER BY id DESC LIMIT 1) AS last_body,
           (SELECT sender FROM messages m WHERE m.advisor_id = u.id ORDER BY id DESC LIMIT 1) AS last_sender,
           (SELECT MAX(created_at) FROM messages m WHERE m.advisor_id = u.id) AS last_at,
           (SELECT COUNT(*) FROM messages m WHERE m.advisor_id = u.id) AS total,
           (SELECT COUNT(*) FROM messages m WHERE m.advisor_id = u.id AND m.sender = 'advisor' AND m.read_at IS NULL) AS unread
    FROM users u
    WHERE u.role != 'admin' AND (u.status != 'invited' OR EXISTS (SELECT 1 FROM messages m WHERE m.advisor_id = u.id))
    ORDER BY (last_at IS NULL), last_at DESC, u.name COLLATE NOCASE`).all();
  res.json(rows.map((u) => ({
    id: u.id, uid: u.uid, name: u.name, role: u.role, organisation: u.organisation, email: u.email,
    state: A.accessState(u), access_type: u.access_type, access_expires_at: u.access_expires_at,
    last_body: u.last_body, last_sender: u.last_sender, last_at: u.last_at, total: u.total, unread: u.unread,
    needs_reply: u.last_sender === 'advisor',
  })));
});
admin.get('/unread', (_req, res) => {
  res.json({ unread: db.prepare("SELECT COUNT(*) AS n FROM messages WHERE sender = 'advisor' AND read_at IS NULL").get().n });
});
admin.get('/:advisorId', (req, res) => {
  const id = Number(req.params.advisorId);
  const msgs = thread(id, req.query.after);
  db.prepare("UPDATE messages SET read_at = ? WHERE advisor_id = ? AND sender = 'advisor' AND read_at IS NULL").run(Date.now(), id);
  res.json(msgs);
});
admin.post('/:advisorId', (req, res) => {
  const id = Number(req.params.advisorId);
  const u = db.prepare("SELECT id FROM users WHERE id = ? AND role != 'admin'").get(id);
  if (!u) return res.status(404).json({ error: 'Member not found.' });
  const body = cleanBody(req.body.body);
  if (!body) return res.status(400).json({ error: 'Type a message first.' });
  const info = db.prepare("INSERT INTO messages (advisor_id, sender, body, created_at) VALUES (?, 'founder', ?, ?)").run(id, body, Date.now());
  notify.founderReplied(id, body);
  res.json(db.prepare('SELECT id, sender, body, created_at, read_at FROM messages WHERE id = ?').get(info.lastInsertRowid));
});

module.exports = { member, admin };
