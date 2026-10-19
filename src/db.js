'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const { DATA_DIR } = require('./config');

const db = new Database(process.env.DB_FILE || path.join(DATA_DIR, 'editor.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer','editor','publisher','admin')),
  pw_hash TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS site_versions (
  site_id TEXT PRIMARY KEY,
  sha TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS change_requests (
  id INTEGER PRIMARY KEY,
  site_id TEXT NOT NULL,
  page TEXT NOT NULL,
  section_index INTEGER NOT NULL,
  section_key TEXT NOT NULL,
  section_label TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  instruction TEXT NOT NULL,
  protected_sections TEXT NOT NULL DEFAULT '[]',
  protected_elements TEXT NOT NULL DEFAULT '[]',
  allow_shared_files INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('draft','submitted')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  cr_id INTEGER NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  ip TEXT
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS generations (
  id INTEGER PRIMARY KEY,
  cr_id INTEGER NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','needs_permission','failed','ready')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  result_sha TEXT,
  result_ref TEXT,
  request_snapshot TEXT NOT NULL,
  changed_files TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  message TEXT,
  checks TEXT NOT NULL DEFAULT '[]',
  flagged TEXT NOT NULL DEFAULT '[]',
  usage TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE (cr_id, n)
);
`);
// A server restart interrupts in-process jobs; never leave them looking active.
db.prepare("UPDATE generations SET status='failed', message='Interrupted by a server restart. Generate again.', finished_at=? WHERE status IN ('queued','running')").run(Date.now());

// Additive migrations (safe to re-run; never drop data).
const genCols = db.prepare('PRAGMA table_info(generations)').all().map((c) => c.name);
[['review_status', "TEXT NOT NULL DEFAULT 'pending'"], ['review_note', 'TEXT'], ['reviewed_by', 'INTEGER'], ['reviewed_at', 'INTEGER'],
  ['shared_change', 'INTEGER NOT NULL DEFAULT 0']]
  .forEach(([c, def]) => { if (!genCols.includes(c)) db.exec(`ALTER TABLE generations ADD COLUMN ${c} ${def}`); });
const crCols = db.prepare('PRAGMA table_info(change_requests)').all().map((c) => c.name);
[
  ['area_kind', "TEXT NOT NULL DEFAULT 'section'"], ['area_key', "TEXT NOT NULL DEFAULT ''"], ['target', 'TEXT'],
  ['change_types', "TEXT NOT NULL DEFAULT '[]'"], ['placement', 'TEXT'], ['devices', "TEXT NOT NULL DEFAULT 'all'"],
  ['requires_shared_approval', 'INTEGER NOT NULL DEFAULT 0'],
].forEach(([c, def]) => { if (!crCols.includes(c)) db.exec(`ALTER TABLE change_requests ADD COLUMN ${c} ${def}`); });
if (!db.prepare('PRAGMA table_info(attachments)').all().some((c) => c.name === 'purpose')) {
  db.exec("ALTER TABLE attachments ADD COLUMN purpose TEXT NOT NULL DEFAULT 'reference'");
}

function audit(userId, action, details = {}, ip = null) {
  db.prepare('INSERT INTO audit_log (ts,user_id,action,details,ip) VALUES (?,?,?,?,?)')
    .run(Date.now(), userId ?? null, action, JSON.stringify(details), ip);
}

module.exports = { db, audit };
