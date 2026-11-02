'use strict';
const crypto = require('node:crypto');
const { db, getSettings } = require('./db');

const COOKIE = 'vg_sid';
const SESSION_MS = 1000 * 60 * 60 * 12; // 12 hours

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_MS;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure}`);
}

function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function loadUser(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  req.user = null;
  if (token) {
    const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                            WHERE s.token = ? AND s.expires_at > ?`).get(token, Date.now());
    if (row) req.user = row;
  }
  next();
}

/** Where a member stands right now: active, expired (temporary window over), pending, rejected or revoked. */
function accessState(u) {
  if (!u) return 'none';
  if (u.role === 'admin') return 'active';
  if (u.status === 'active') {
    if (u.access_type === 'temporary' && (!u.access_expires_at || u.access_expires_at <= Date.now())) return 'expired';
    return 'active';
  }
  return u.status; // invited | pending | rejected | revoked
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, uid: u.uid, role: u.role, name: u.name, email: u.email, phone: u.phone,
    organisation: u.organisation, status: u.status, access_type: u.access_type,
    access_expires_at: u.access_expires_at, approved_at: u.approved_at, signup_at: u.signup_at,
    renewal_requested: !!u.renewal_requested, last_login_at: u.last_login_at, created_at: u.created_at,
    state: accessState(u),
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in.' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  next();
}
/** Advisors and investors whose access is live right now. */
function requireMember(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in.' });
  if (req.user.role === 'admin') return res.status(403).json({ error: 'This area is for advisors and investors.' });
  const state = accessState(req.user);
  if (state !== 'active') return res.status(403).json({ error: 'Your access is not active.', state });
  next();
}

// Small in-memory limiter for login and signup: 10 attempts per 10 minutes per IP.
const attempts = new Map();
function rateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const rec = attempts.get(key) || { n: 0, reset: now + 10 * 60 * 1000 };
  if (rec.reset < now) { rec.n = 0; rec.reset = now + 10 * 60 * 1000; }
  rec.n += 1;
  attempts.set(key, rec);
  if (rec.n > 10) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  next();
}
function clearRateLimit(req) { attempts.delete(req.ip); }

function logAccess(userId, action, detail) {
  db.prepare('INSERT INTO access_log (user_id, action, detail, at) VALUES (?, ?, ?, ?)').run(userId, action, detail || null, Date.now());
}

function tempHours() {
  const h = Number(getSettings().temp_access_hours);
  return Number.isFinite(h) && h > 0 ? h : 72;
}

module.exports = {
  createSession, destroySession, loadUser, accessState, publicUser,
  requireAuth, requireAdmin, requireMember, rateLimit, clearRateLimit, logAccess, tempHours,
};
