import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { FileRecord, DownloadLog, User, Permission } from '@/types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  filename     TEXT NOT NULL,
  original_name TEXT NOT NULL,
  sha256       TEXT NOT NULL UNIQUE,
  size         INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  gcs_key      TEXT NOT NULL UNIQUE,
  token_hash   TEXT NOT NULL,
  expires_at   INTEGER,
  uploaded_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  uploaded_by  TEXT
);
CREATE TABLE IF NOT EXISTS download_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id       INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  downloaded_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  permissions   TEXT NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

// ── Schema migrations ─────────────────────────────────────────────────────────
// Keyed by target user_version. Add new entries here; never edit existing ones.
// The live DB was bootstrapped from a prototype with only:
//   id, md5, gcs_key, token_hash, expires_at, uploaded_at
// user_version=0 means "no migrations applied yet".

const MIGRATIONS: Record<number, (db: Database.Database) => void> = {
  1: (db) => {
    // Rename md5 → sha256; add all columns that the prototype schema lacked.
    const cols = new Set(
      (db.prepare("SELECT name FROM pragma_table_info('files')").all() as { name: string }[]).map(r => r.name)
    );
    if (cols.has('md5')) db.exec('ALTER TABLE files RENAME COLUMN md5 TO sha256');
    if (!cols.has('content_type'))  db.exec("ALTER TABLE files ADD COLUMN content_type TEXT NOT NULL DEFAULT 'application/octet-stream'");
    if (!cols.has('size'))          db.exec('ALTER TABLE files ADD COLUMN size INTEGER NOT NULL DEFAULT 0');
    if (!cols.has('filename'))      db.exec("ALTER TABLE files ADD COLUMN filename TEXT NOT NULL DEFAULT ''");
    if (!cols.has('original_name')) db.exec("ALTER TABLE files ADD COLUMN original_name TEXT NOT NULL DEFAULT ''");
    if (!cols.has('uploaded_by'))   db.exec('ALTER TABLE files ADD COLUMN uploaded_by TEXT');
    // Backfill text columns from gcs_key for any pre-existing rows.
    db.exec("UPDATE files SET filename = gcs_key WHERE filename = ''");
    db.exec("UPDATE files SET original_name = gcs_key WHERE original_name = ''");

    // users table: add created_at if the prototype schema omitted it.
    // Default to unixepoch() so existing rows get a sensible timestamp.
    const userCols = new Set(
      (db.prepare("SELECT name FROM pragma_table_info('users')").all() as { name: string }[]).map(r => r.name)
    );
    if (!userCols.has('created_at')) {
      db.exec('ALTER TABLE users ADD COLUMN created_at INTEGER NOT NULL DEFAULT (unixepoch())');
    }
  },
};

function runMigrations(db: Database.Database): void {
  const current = (db.pragma('user_version', { simple: true }) as number);
  const versions = Object.keys(MIGRATIONS).map(Number).sort((a, b) => a - b);
  for (const v of versions) {
    if (v > current) {
      db.transaction(() => {
        MIGRATIONS[v](db);
        db.pragma(`user_version = ${v}`);
      })();
    }
  }
}

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = process.env.DATABASE_PATH ?? './data/fileshare.db';
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  runMigrations(db);

  _db = db;
  return _db;
}

// Reset the singleton — used in tests only
export function _resetDb(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
}

type InsertFileData = Omit<FileRecord, 'id' | 'uploaded_at'>;

export function insertFile(data: InsertFileData): FileRecord {
  const db = getDb();
  const stmt = db.prepare<InsertFileData>(`
    INSERT INTO files (filename, original_name, sha256, size, content_type, gcs_key, token_hash, expires_at, uploaded_by)
    VALUES (@filename, @original_name, @sha256, @size, @content_type, @gcs_key, @token_hash, @expires_at, @uploaded_by)
  `);
  const result = stmt.run(data);
  const record = db.prepare<[number], FileRecord>('SELECT * FROM files WHERE id = ?').get(result.lastInsertRowid as number);
  if (!record) throw new Error('insertFile: row not found after insert');
  return record;
}

export function getFileBySha256(sha256: string): FileRecord | undefined {
  const db = getDb();
  return db.prepare<[string], FileRecord>('SELECT * FROM files WHERE sha256 = ?').get(sha256);
}

export function getFileById(id: number): FileRecord | undefined {
  const db = getDb();
  return db.prepare<[number], FileRecord>('SELECT * FROM files WHERE id = ?').get(id);
}

export function logDownload(fileId: number): void {
  const db = getDb();
  db.prepare<[number]>('INSERT INTO download_logs (file_id) VALUES (?)').run(fileId);
}

export function getDownloadCount(fileId: number): number {
  const db = getDb();
  const row = db
    .prepare<[number], { 'COUNT(*)': number }>('SELECT COUNT(*) FROM download_logs WHERE file_id = ?')
    .get(fileId);
  return row ? row['COUNT(*)'] : 0;
}

export function getDownloadLogs(fileId: number): DownloadLog[] {
  const db = getDb();
  return db
    .prepare<[number], DownloadLog>(
      'SELECT * FROM download_logs WHERE file_id = ? ORDER BY downloaded_at DESC',
    )
    .all(fileId);
}

export function listFiles(): (FileRecord & { download_count: number })[] {
  const db = getDb();
  return db
    .prepare<[], FileRecord & { download_count: number }>(
      `SELECT f.*, COUNT(dl.id) as download_count
       FROM files f
       LEFT JOIN download_logs dl ON dl.file_id = f.id
       GROUP BY f.id
       ORDER BY f.uploaded_at DESC`,
    )
    .all();
}

export function updateFileExpiry(id: number, expiresAt: number | null): void {
  const db = getDb();
  db.prepare<[number | null, number]>('UPDATE files SET expires_at = ? WHERE id = ?').run(expiresAt, id);
}

export function updateFileTokenHash(id: number, hash: string): void {
  const db = getDb();
  db.prepare<[string, number]>('UPDATE files SET token_hash = ? WHERE id = ?').run(hash, id);
}

export function deleteFile(id: number): void {
  const db = getDb();
  db.prepare<[number]>('DELETE FROM files WHERE id = ?').run(id);
}

export function getExpiredFiles(): FileRecord[] {
  const db = getDb();
  return db
    .prepare<[], FileRecord>(
      'SELECT * FROM files WHERE expires_at IS NOT NULL AND expires_at < unixepoch() ORDER BY expires_at ASC',
    )
    .all();
}

// Raw DB row shape for users — permissions is a JSON string before parsing
interface DbUserRow {
  id: number;
  username: string;
  password_hash: string;
  permissions: string;
  created_at: number;
}

function parseUser(row: DbUserRow): User {
  return {
    ...row,
    permissions: JSON.parse(row.permissions) as Permission[],
  };
}

export function getUserByUsername(username: string): User | undefined {
  const db = getDb();
  const row = db
    .prepare<[string], DbUserRow>('SELECT * FROM users WHERE username = ?')
    .get(username);
  return row ? parseUser(row) : undefined;
}

export function getUserById(id: number): User | undefined {
  const db = getDb();
  const row = db
    .prepare<[number], DbUserRow>('SELECT * FROM users WHERE id = ?')
    .get(id);
  return row ? parseUser(row) : undefined;
}

export function listUsers(): User[] {
  const db = getDb();
  const rows = db.prepare<[], DbUserRow>('SELECT * FROM users ORDER BY id ASC').all();
  return rows.map(parseUser);
}

export function createUser(data: {
  username: string;
  password_hash: string;
  permissions: Permission[];
}): User {
  const db = getDb();
  const result = db
    .prepare<[string, string, string]>(
      'INSERT INTO users (username, password_hash, permissions) VALUES (?, ?, ?)',
    )
    .run(data.username, data.password_hash, JSON.stringify(data.permissions));
  const created = getUserById(result.lastInsertRowid as number);
  if (!created) throw new Error('createUser: row not found after insert');
  return created;
}

export function updateUser(
  id: number,
  patch: { username?: string; password_hash?: string; permissions?: Permission[] },
): void {
  const fields: string[] = [];
  const values: (string | number)[] = [];

  if (patch.username !== undefined) {
    fields.push('username = ?');
    values.push(patch.username);
  }
  if (patch.password_hash !== undefined) {
    fields.push('password_hash = ?');
    values.push(patch.password_hash);
  }
  if (patch.permissions !== undefined) {
    fields.push('permissions = ?');
    values.push(JSON.stringify(patch.permissions));
  }

  if (fields.length === 0) return;

  values.push(id);
  const db = getDb();
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteUser(id: number): void {
  const db = getDb();
  db.prepare<[number]>('DELETE FROM users WHERE id = ?').run(id);
}
