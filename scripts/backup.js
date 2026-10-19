'use strict';
// Online, consistent SQLite backup + integrity verification of the copy. Keeps the newest 30.
// Usage: node scripts/backup.js [destDir]   (schedule daily; copy destDir off the server)
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DATA_DIR } = require('../src/config');

async function backup(dest = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups')) {
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  const src = new Database(process.env.DB_FILE || path.join(DATA_DIR, 'editor.db'), { readonly: true });
  const file = path.join(dest, `editor-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  await src.backup(file);
  src.close();
  const copy = new Database(file, { readonly: true });
  const ok = copy.pragma('integrity_check', { simple: true }) === 'ok';
  const counts = Object.fromEntries(['users', 'change_requests', 'attachments', 'audit_log']
    .map((t) => [t, copy.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
  copy.close();
  if (!ok) throw new Error(`Backup failed integrity check: ${file}`);
  fs.readdirSync(dest).filter((f) => /^editor-.*\.db$/.test(f)).sort().slice(0, -30).forEach((f) => fs.rmSync(path.join(dest, f)));
  return { file, counts };
}
if (require.main === module) backup(process.argv[2]).then((r) => console.log('Backup OK', r)).catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { backup };
