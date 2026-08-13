// This script is invoked directly via `node scripts/bootstrap-admin.js` with
// no build step (see GCP_DEPLOYMENT_PLAN.md's `gcloud run jobs execute`
// example) and package.json has no `"type": "module"`, so it must stay
// CommonJS rather than adopt the ESM `import` syntax the rest of the
// TypeScript codebase uses via the Next.js/tsc toolchain.
/* eslint-disable @typescript-eslint/no-require-imports */
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
/* eslint-enable @typescript-eslint/no-require-imports */

const dbPath = process.env.DATABASE_PATH || '/data/fileshare.db';
const username = process.env.ADMIN_USER;
const password = process.env.ADMIN_PASS;

if (!username || !password) {
  console.error('ADMIN_USER and ADMIN_PASS are required');
  process.exit(1);
}

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    permissions TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    md5 TEXT NOT NULL UNIQUE,
    gcs_key TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at INTEGER,
    uploaded_at INTEGER NOT NULL DEFAULT (unixepoch()),
    uploaded_by TEXT
  );
  CREATE TABLE IF NOT EXISTS download_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    downloaded_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
  );
`);

const existing = db.prepare('SELECT COUNT(*) as n FROM users WHERE username = ?').get(username);
if (existing.n > 0) {
  console.log(`User '${username}' already exists, skipping.`);
  db.close();
  process.exit(0);
}

bcrypt.hash(password, 10).then(hash => {
  db.prepare('INSERT INTO users (username, password_hash, permissions) VALUES (?, ?, ?)')
    .run(username, hash, '["admin","upload"]');
  console.log(`Admin user '${username}' created successfully.`);
  db.close();
});
