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

db.exec(`
CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  kind TEXT,
  status TEXT NOT NULL,           -- sent | failed | skipped (email not set up)
  error TEXT,
  at INTEGER NOT NULL
);
-- "Request a VINC ID" form on the public site.
CREATE TABLE IF NOT EXISTS id_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  organisation TEXT,
  role TEXT NOT NULL DEFAULT 'advisor',
  message TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','approved','dismissed')),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ip TEXT,
  created_at INTEGER NOT NULL,
  handled_at INTEGER
);
`);

db.exec(`
-- Onboarding agreements (see server/agreements.js).
CREATE TABLE IF NOT EXISTS agreement_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('advisory','term_sheet','custom')),
  title TEXT,
  stored_name TEXT NOT NULL,
  original_name TEXT,
  sha256 TEXT,
  pages INTEGER,
  fields TEXT,
  required INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  uploaded_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agreements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('advisory','term_sheet','custom')),
  template_id INTEGER REFERENCES agreement_templates(id),
  mandatory INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','member_signed','executed','void')),
  fields TEXT,
  member_sig TEXT, member_signed_at INTEGER, member_place TEXT, member_geo TEXT, member_ip TEXT, member_ua TEXT,
  company_sig TEXT, company_signed_at INTEGER, company_place TEXT, company_signer TEXT, company_method TEXT, company_ip TEXT,
  executed_name TEXT, executed_sha256 TEXT,
  void_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS agreement_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_id INTEGER NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT
);
`);

// Columns added after the first release: add them to existing databases.
function addColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

// The first agreements release only allowed the two built-in documents. Rebuild those tables once so they
// also accept custom agreements (SQLite cannot change a CHECK in place). Data is copied across unchanged.
function relaxKindCheck(table) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  const OLD = "CHECK (kind IN ('advisory','term_sheet'))";
  if (!row || !row.sql.includes(OLD)) return;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).join(', ');
  const sql = row.sql.replace(OLD, "CHECK (kind IN ('advisory','term_sheet','custom'))").replace(/^CREATE TABLE (IF NOT EXISTS )?"?\w+"?/, `CREATE TABLE ${table}__new`);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(sql);
    db.exec(`INSERT INTO ${table}__new (${cols}) SELECT ${cols} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${table}__new RENAME TO ${table}`);
    db.exec('COMMIT');
    console.log(`[db] upgraded table ${table} for custom agreements`);
  } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.exec('PRAGMA foreign_keys = ON'); }
}
relaxKindCheck('agreement_templates');
relaxKindCheck('agreements');
addColumn('agreement_templates', 'title', 'title TEXT');
addColumn('agreement_templates', 'fields', 'fields TEXT');
addColumn('agreement_templates', 'required', 'required INTEGER NOT NULL DEFAULT 0');
addColumn('agreements', 'mandatory', 'mandatory INTEGER NOT NULL DEFAULT 1');
db.exec('CREATE INDEX IF NOT EXISTS idx_agreements_user ON agreements(user_id, kind)');
addColumn('users', 'email_updates', 'email_updates INTEGER NOT NULL DEFAULT 1');

const DEFAULT_SETTINGS = {
  company_name: 'VINC',
  founder_name: 'the Founder',
  currency: '₹',
  temp_access_hours: '72',
  contact_email: 'info@vinc-global.com',
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
