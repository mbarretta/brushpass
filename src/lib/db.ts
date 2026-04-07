import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { FileRecord, DownloadLog, User, Permission, FileGroup, FileGroupWithFiles, PermissionRequest } from '@/types';

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
  password_hash TEXT,
  email         TEXT UNIQUE,
  auth_provider TEXT NOT NULL DEFAULT 'credentials',
  permissions   TEXT NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS permission_requests (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_permissions TEXT NOT NULL DEFAULT '[]',
  requested_at         INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS file_groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  expires_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS file_group_members (
  group_id INTEGER NOT NULL REFERENCES file_groups(id) ON DELETE CASCADE,
  file_id  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (group_id, file_id)
);
`;

// ── Schema migrations ─────────────────────────────────────────────────────────
// Keyed by target user_version. Add new entries here; never edit existing ones.
// The live DB was bootstrapped from a prototype with only:
//   id, md5, gcs_key, token_hash, expires_at, uploaded_at
// user_version=0 means "no migrations applied yet".

const MIGRATIONS: Record<number, (db: Database.Database) => void> = {
  3: (db) => {
    // Add email, auth_provider columns to users; make password_hash nullable.
    // Also create permission_requests table.
    // Guard: only run if auth_provider column does NOT yet exist.
    const cols = new Set(
      (db.prepare("SELECT name FROM pragma_table_info('users')").all() as { name: string }[]).map(r => r.name)
    );
    if (!cols.has('auth_provider')) {
      // Table rebuild: preserve existing rows, add new columns, relax NOT NULL on password_hash.
      db.exec(`
        ALTER TABLE users RENAME TO users_old;
        CREATE TABLE users (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          username      TEXT NOT NULL UNIQUE,
          password_hash TEXT,
          email         TEXT UNIQUE,
          auth_provider TEXT NOT NULL DEFAULT 'credentials',
          permissions   TEXT NOT NULL DEFAULT '[]',
          created_at    INTEGER NOT NULL DEFAULT (unixepoch())
        );
        INSERT INTO users (id, username, password_hash, email, auth_provider, permissions, created_at)
          SELECT id, username, password_hash, NULL, 'credentials', permissions, created_at
          FROM users_old;
        DROP TABLE users_old;
      `);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS permission_requests (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        requested_permissions TEXT NOT NULL DEFAULT '[]',
        requested_at          INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
  },
  2: (db) => {
    // Add file_groups and file_group_members for existing DBs that predate the SCHEMA block above.
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_groups (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        slug       TEXT NOT NULL UNIQUE,
        token_hash TEXT NOT NULL,
        expires_at INTEGER,
        created_by TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS file_group_members (
        group_id INTEGER NOT NULL REFERENCES file_groups(id) ON DELETE CASCADE,
        file_id  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        added_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (group_id, file_id)
      );
    `);
  },
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

export function getDownloadLogsPaginated(
  fileId: number,
  limit: number,
  offset: number,
): DownloadLog[] {
  const db = getDb();
  return db
    .prepare<[number, number, number], DownloadLog>(
      'SELECT * FROM download_logs WHERE file_id = ? ORDER BY downloaded_at DESC LIMIT ? OFFSET ?',
    )
    .all(fileId, limit, offset);
}

export function getDownloadLogCount(fileId: number): number {
  const db = getDb();
  const row = db
    .prepare<[number], { count: number }>(
      'SELECT COUNT(*) as count FROM download_logs WHERE file_id = ?',
    )
    .get(fileId);
  return row?.count ?? 0;
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
  password_hash: string | null;
  email: string | null;
  auth_provider: string;
  permissions: string;
  created_at: number;
}

function parseUser(row: DbUserRow): User {
  return {
    ...row,
    auth_provider: row.auth_provider as 'credentials' | 'oidc',
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

export function getUserByEmail(email: string): User | undefined {
  const db = getDb();
  const row = db
    .prepare<[string], DbUserRow>('SELECT * FROM users WHERE email = ?')
    .get(email);
  return row ? parseUser(row) : undefined;
}

/** Alias for getUserByEmail — used by jwt callback and OIDC helpers. */
export function getOidcUserByEmail(email: string): User | undefined {
  return getUserByEmail(email);
}

/**
 * Upsert an OIDC user. On first sign-in inserts a new row (username = email,
 * password_hash = NULL, auth_provider = 'oidc'). On subsequent sign-ins the
 * INSERT OR IGNORE is a no-op and we return the existing row unchanged.
 */
export function upsertOidcUser(
  email: string,
  name: string,
  permissions: Permission[],
): User {
  const db = getDb();
  db
    .prepare<[string, string, string]>(
      `INSERT OR IGNORE INTO users (username, password_hash, email, auth_provider, permissions)
       VALUES (?, NULL, ?, 'oidc', ?)`,
    )
    .run(name || email, email, JSON.stringify(permissions));
  const user = getUserByEmail(email);
  if (!user) throw new Error('upsertOidcUser: row not found after upsert');
  return user;
}

export function createPermissionRequest(
  userId: number,
  requestedPermissions: Permission[],
): void {
  const db = getDb();
  db
    .prepare<[number, string]>(
      'INSERT INTO permission_requests (user_id, requested_permissions) VALUES (?, ?)',
    )
    .run(userId, JSON.stringify(requestedPermissions));
}

interface DbPermissionRequestRow {
  id: number;
  user_id: number;
  requested_permissions: string;
  requested_at: number;
  username: string;
  email: string | null;
}

export function listPendingPermissionRequests(): PermissionRequest[] {
  const db = getDb();
  const rows = db
    .prepare<[], DbPermissionRequestRow>(
      `SELECT pr.*, u.username, u.email
       FROM permission_requests pr
       JOIN users u ON u.id = pr.user_id
       ORDER BY pr.requested_at ASC`,
    )
    .all();
  return rows.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    username: r.username,
    email: r.email,
    requested_permissions: JSON.parse(r.requested_permissions) as Permission[],
    requested_at: r.requested_at,
  }));
}

export function approvePermissionRequest(
  requestId: number,
  permissions: Permission[],
): void {
  const db = getDb();
  db.transaction(() => {
    const row = db
      .prepare<[number], { user_id: number }>('SELECT user_id FROM permission_requests WHERE id = ?')
      .get(requestId);
    if (!row) return;
    db
      .prepare<[string, number]>('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(permissions), row.user_id);
    db
      .prepare<[number]>('DELETE FROM permission_requests WHERE id = ?')
      .run(requestId);
  })();
}

export function denyPermissionRequest(requestId: number): void {
  const db = getDb();
  db.prepare<[number]>('DELETE FROM permission_requests WHERE id = ?').run(requestId);
}

export function getPendingRequestCount(): number {
  const db = getDb();
  const row = db
    .prepare<[], { count: number }>('SELECT COUNT(*) as count FROM permission_requests')
    .get();
  return row?.count ?? 0;
}

export function getGroupsForFile(fileId: number): FileGroup[] {
  const db = getDb();
  return db
    .prepare<[number], FileGroup>(
      `SELECT g.* FROM file_groups g
       INNER JOIN file_group_members m ON m.group_id = g.id
       WHERE m.file_id = ?
       ORDER BY g.name ASC`,
    )
    .all(fileId);
}

// ── File group helpers ────────────────────────────────────────────────────────

/** Slug: 1–64 chars, lowercase alphanumeric and hyphens, no leading/trailing hyphens. */
export function isValidSlug(s: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/.test(s);
}

type InsertGroupData = Omit<FileGroup, 'id' | 'created_at'>;

export function insertGroup(data: InsertGroupData): FileGroup {
  const db = getDb();
  const result = db
    .prepare<InsertGroupData>(
      `INSERT INTO file_groups (name, slug, token_hash, expires_at, created_by)
       VALUES (@name, @slug, @token_hash, @expires_at, @created_by)`,
    )
    .run(data);
  const record = db
    .prepare<[number], FileGroup>('SELECT * FROM file_groups WHERE id = ?')
    .get(result.lastInsertRowid as number);
  if (!record) throw new Error('insertGroup: row not found after insert');
  return record;
}

export function getGroupBySlug(slug: string): FileGroup | undefined {
  const db = getDb();
  return db
    .prepare<[string], FileGroup>('SELECT * FROM file_groups WHERE slug = ?')
    .get(slug);
}

export function getGroupById(id: number): FileGroup | undefined {
  const db = getDb();
  return db
    .prepare<[number], FileGroup>('SELECT * FROM file_groups WHERE id = ?')
    .get(id);
}

export function listGroups(): (FileGroup & { member_count: number })[] {
  const db = getDb();
  return db
    .prepare<[], FileGroup & { member_count: number }>(
      `SELECT g.*, COUNT(m.file_id) as member_count
       FROM file_groups g
       LEFT JOIN file_group_members m ON m.group_id = g.id
       GROUP BY g.id
       ORDER BY g.created_at DESC`,
    )
    .all();
}

export function updateGroup(
  id: number,
  patch: { name?: string; slug?: string; expires_at?: number | null; token_hash?: string },
): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (patch.name !== undefined)       { fields.push('name = ?');       values.push(patch.name); }
  if (patch.slug !== undefined)       { fields.push('slug = ?');       values.push(patch.slug); }
  if ('expires_at' in patch)          { fields.push('expires_at = ?'); values.push(patch.expires_at ?? null); }
  if (patch.token_hash !== undefined) { fields.push('token_hash = ?'); values.push(patch.token_hash); }

  if (fields.length === 0) return;
  values.push(id);
  const db = getDb();
  db.prepare(`UPDATE file_groups SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteGroup(id: number): void {
  const db = getDb();
  db.prepare<[number]>('DELETE FROM file_groups WHERE id = ?').run(id);
}

export function addFileToGroup(groupId: number, fileId: number): void {
  const db = getDb();
  db
    .prepare<[number, number]>(
      'INSERT OR IGNORE INTO file_group_members (group_id, file_id) VALUES (?, ?)',
    )
    .run(groupId, fileId);
}

export function removeFileFromGroup(groupId: number, fileId: number): void {
  const db = getDb();
  db
    .prepare<[number, number]>(
      'DELETE FROM file_group_members WHERE group_id = ? AND file_id = ?',
    )
    .run(groupId, fileId);
}

export function listGroupFiles(groupId: number): FileRecord[] {
  const db = getDb();
  return db
    .prepare<[number], FileRecord>(
      `SELECT f.* FROM files f
       INNER JOIN file_group_members m ON m.file_id = f.id
       WHERE m.group_id = ?
       ORDER BY m.added_at ASC`,
    )
    .all(groupId);
}

export function getGroupWithFiles(slug: string): FileGroupWithFiles | undefined {
  const db = getDb();
  const group = db
    .prepare<[string], FileGroup>('SELECT * FROM file_groups WHERE slug = ?')
    .get(slug);
  if (!group) return undefined;
  const files = db
    .prepare<[number], FileRecord>(
      `SELECT f.* FROM files f
       INNER JOIN file_group_members m ON m.file_id = f.id
       WHERE m.group_id = ?
       ORDER BY m.added_at ASC`,
    )
    .all(group.id);
  return { ...group, files };
}
