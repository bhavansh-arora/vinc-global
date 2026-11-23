'use strict';
// Create a view-only account, or give an existing one a new password, from the server's command line.
//   docker exec vinc-global node server/tools/add-viewer.js "Full Name" [VINC-ID] [Designation]
// The password is generated here and printed once; it is stored only as a hash.
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../db');

const [name, uidArg, designation] = process.argv.slice(2);
if (!name) { console.error('Usage: node server/tools/add-viewer.js "Full Name" [VINC-ID] [Designation]'); process.exit(1); }
const uid = (uidArg || 'VG-CS-01').toUpperCase();
if (!/^[A-Z0-9][A-Z0-9-]{3,39}$/.test(uid) || uid === 'ADMIN') { console.error('IDs use letters, numbers and dashes (4-40 characters).'); process.exit(1); }
const al = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
let password = '';
while (!(/[A-Za-z]/.test(password) && /[0-9]/.test(password))) { password = ''; for (const b of crypto.randomBytes(14)) password += al[b % al.length]; }
const hash = bcrypt.hashSync(password, 10);
const existing = db.prepare('SELECT * FROM users WHERE uid = ?').get(uid);
const now = Date.now();
if (existing) {
  if (existing.role !== 'viewer') { console.error(`${uid} belongs to an existing ${existing.role}; choose another ID.`); process.exit(1); }
  db.prepare("UPDATE users SET name = ?, password_hash = ?, status = 'active', organisation = COALESCE(?, organisation) WHERE id = ?").run(name, hash, designation || null, existing.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
  console.log(`Updated view-only account ${uid} with a new password.`);
} else {
  db.prepare("INSERT INTO users (uid, role, name, organisation, password_hash, status, access_type, approved_at, signup_at, created_at) VALUES (?, 'viewer', ?, ?, ?, 'active', 'permanent', ?, ?, ?)")
    .run(uid, name, designation || 'Company Secretary', hash, now, now, now);
  console.log(`Created view-only account ${uid} for ${name}.`);
}
console.log(`\n  VINC ID:  ${uid}\n  Password: ${password}\n\nLog in at the portal's /login page. Share the password privately; it is not shown again.`);
