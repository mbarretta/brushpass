import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { FileRecord, DownloadLog } from '@/types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  filename     TEXT NOT NULL,
  original_name TEXT NOT NULL,
  md5          TEXT NOT NULL UNIQUE,
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

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = process.env.DATABASE_PATH ?? './data/fileshare.db';
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

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
    INSERT INTO files (filename, original_name, md5, size, content_type, gcs_key, token_hash, expires_at, uploaded_by)
    VALUES (@filename, @original_name, @md5, @size, @content_type, @gcs_key, @token_hash, @expires_at, @uploaded_by)
  `);
  const result = stmt.run(data);
  const record = db.prepare<[number], FileRecord>('SELECT * FROM files WHERE id = ?').get(result.lastInsertRowid as number);
  if (!record) throw new Error('insertFile: row not found after insert');
  return record;
}

export function getFileByMd5(md5: string): FileRecord | undefined {
  const db = getDb();
  return db.prepare<[string], FileRecord>('SELECT * FROM files WHERE md5 = ?').get(md5);
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
