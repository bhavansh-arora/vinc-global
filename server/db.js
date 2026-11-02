'use strict';
// SQLite database (Node's built-in node:sqlite, so there is nothing native to compile on the host).
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'vinc-global.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('admin','advisor','investor')),
  name TEXT,
  email TEXT,
  phone TEXT,
  organisation TEXT,
  password_hash TEXT,
  -- invited: id generated, not signed up yet | pending: waiting for approval | active | rejected | revoked
  status TEXT NOT NULL DEFAULT 'invited',
  access_type TEXT CHECK (access_type IN ('temporary','permanent') OR access_type IS NULL),
  access_expires_at INTEGER,
  renewal_requested INTEGER NOT NULL DEFAULT 0,
  signup_at INTEGER,
  approved_at INTEGER,
  last_login_at INTEGER,
  notes TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  detail TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tag TEXT,
  visibility TEXT NOT NULL DEFAULT 'members' CHECK (visibility IN ('public','members')),
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
-- Resources the admin publishes: an uploaded PDF, an uploaded Excel sheet, or a link. All are view only.
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'general',
  kind TEXT NOT NULL CHECK (kind IN ('pdf','excel','link')),
  stored_name TEXT,
  original_name TEXT,
  mime TEXT,
  size INTEGER,
  url TEXT,
  audience_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kyc_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  original_name TEXT,
  mime TEXT,
  size INTEGER,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','verified','rejected')),
  remark TEXT,
  uploaded_at INTEGER NOT NULL,
  reviewed_at INTEGER
);
CREATE TABLE IF NOT EXISTS investments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invested_on TEXT NOT NULL,
  amount REAL NOT NULL,
  shares REAL NOT NULL,
  round TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS certificates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  certificate_no TEXT,
  stored_name TEXT NOT NULL,
  original_name TEXT,
  mime TEXT,
  size INTEGER,
  created_at INTEGER NOT NULL
);
-- Share price points set by the admin. kind = actual (the price on that date) or projected (a target).
CREATE TABLE IF NOT EXISTS share_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  on_date TEXT NOT NULL,
  price REAL NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('actual','projected')),
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  advisor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('advisor','founder')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_advisor ON messages(advisor_id, id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

const DEFAULT_SETTINGS = {
  company_name: 'VINC',
  founder_name: 'the Founder',
  currency: '₹',
  temp_access_hours: '72',
  contact_email: 'info@vinc-lab.com',
};

function seed() {
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (!admin) {
    const pwd = process.env.ADMIN_PASSWORD || 'Vinc@2026';
    db.prepare(`INSERT INTO users (uid, role, name, password_hash, status, access_type, created_at, signup_at, approved_at)
                VALUES ('admin', 'admin', 'Administrator', ?, 'active', 'permanent', ?, ?, ?)`)
      .run(bcrypt.hashSync(pwd, 10), Date.now(), Date.now(), Date.now());
    console.log('[seed] admin account created (uid: admin)');
  }
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
}
seed();

function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, DATA_DIR, UPLOAD_DIR, getSettings, tx };
