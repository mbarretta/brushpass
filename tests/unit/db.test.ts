import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Each test run uses an isolated temp DB path to avoid singleton conflicts
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileshare-test-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
});

afterEach(async () => {
  // Reset the module singleton so next test gets a fresh DB
  const mod = await import('@/lib/db');
  mod._resetDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

describe('getDb()', () => {
  it('returns a Database instance', async () => {
    const { getDb } = await import('@/lib/db');
    const db = getDb();
    expect(db).toBeDefined();
    expect(typeof db.prepare).toBe('function');
  });

  it('creates all three schema tables', async () => {
    const { getDb } = await import('@/lib/db');
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('files');
    expect(names).toContain('download_logs');
    expect(names).toContain('users');
  });

  it('enables WAL journal mode', async () => {
    const { getDb } = await import('@/lib/db');
    const db = getDb();
    const row = db.pragma('journal_mode') as { journal_mode: string }[];
    expect(row[0].journal_mode).toBe('wal');
  });

  it('returns the same instance on repeated calls (singleton)', async () => {
    const { getDb } = await import('@/lib/db');
    const a = getDb();
    const b = getDb();
    expect(a).toBe(b);
  });
});

describe('insertFile / getFileByMd5 / getFileById', () => {
  it('insertFile round-trips through getFileByMd5', async () => {
    const { insertFile, getFileByMd5 } = await import('@/lib/db');
    const data = {
      filename: 'abc123.txt',
      original_name: 'hello.txt',
      md5: 'abc123def456abc123def456abc12345',
      size: 11,
      content_type: 'text/plain',
      gcs_key: 'abc123def456abc123def456abc12345.txt',
      token_hash: '$2b$10$fakehashvalue',
      expires_at: null,
      uploaded_by: null,
    };
    const inserted = insertFile(data);
    expect(inserted.id).toBeGreaterThan(0);
    expect(inserted.md5).toBe(data.md5);
    expect(inserted.filename).toBe(data.filename);

    const found = getFileByMd5(data.md5);
    expect(found).toBeDefined();
    expect(found!.id).toBe(inserted.id);
    expect(found!.original_name).toBe('hello.txt');
  });

  it('getFileByMd5 returns undefined for unknown md5', async () => {
    const { getFileByMd5 } = await import('@/lib/db');
    expect(getFileByMd5('nonexistent')).toBeUndefined();
  });

  it('getFileById returns the correct record', async () => {
    const { insertFile, getFileById } = await import('@/lib/db');
    const data = {
      filename: 'xyz789.txt',
      original_name: 'world.txt',
      md5: 'xyz789000000xyz789000000xyz78900',
      size: 5,
      content_type: 'text/plain',
      gcs_key: 'xyz789000000xyz789000000xyz78900.txt',
      token_hash: '$2b$10$anotherfakehash',
      expires_at: 9999999999,
      uploaded_by: 'tester',
    };
    const inserted = insertFile(data);
    const found = getFileById(inserted.id);
    expect(found).toBeDefined();
    expect(found!.uploaded_by).toBe('tester');
    expect(found!.expires_at).toBe(9999999999);
  });

  it('getFileById returns undefined for unknown id', async () => {
    const { getFileById } = await import('@/lib/db');
    expect(getFileById(99999)).toBeUndefined();
  });
});
