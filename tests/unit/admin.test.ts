import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileshare-admin-test-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
});

afterEach(async () => {
  const mod = await import('@/lib/db');
  mod._resetDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

/** Insert a minimal file record and return its id */
async function insertTestFile(overrides: {
  sha256?: string;
  expires_at?: number | null;
} = {}): Promise<number> {
  const { insertFile } = await import('@/lib/db');
  const sha256 = overrides.sha256 ?? 'aabbccdd00000000aabbccdd00000000aabbccdd00000000aabbccdd00000000';
  const record = insertFile({
    filename: `${sha256}.txt`,
    original_name: 'test.txt',
    sha256,
    size: 4,
    content_type: 'text/plain',
    gcs_key: `${sha256}.txt`,
    token_hash: '$2b$10$fakehashvalue',
    expires_at: overrides.expires_at !== undefined ? overrides.expires_at : null,
    uploaded_by: null,
  });
  return record.id;
}

// ── listFiles ────────────────────────────────────────────────────────────────

describe('listFiles', () => {
  it('returns an empty array when no files exist', async () => {
    const { listFiles } = await import('@/lib/db');
    expect(listFiles()).toEqual([]);
  });

  it('returns one file with download_count 0 when no downloads logged', async () => {
    const { listFiles } = await import('@/lib/db');
    const fileId = await insertTestFile();
    const files = listFiles();
    expect(files).toHaveLength(1);
    expect(files[0].id).toBe(fileId);
    expect(files[0].download_count).toBe(0);
  });

  it('returns correct download_count after logDownload calls', async () => {
    const { listFiles, logDownload } = await import('@/lib/db');
    const fileId = await insertTestFile();
    logDownload(fileId);
    logDownload(fileId);
    logDownload(fileId);
    const files = listFiles();
    expect(files[0].download_count).toBe(3);
  });

  it('returns files ordered by uploaded_at DESC when multiple files exist', async () => {
    const { listFiles, getDb } = await import('@/lib/db');
    // Insert two files with different uploaded_at values by direct SQL
    const db = getDb();
    db.prepare(
      `INSERT INTO files (filename, original_name, sha256, size, content_type, gcs_key, token_hash, uploaded_at)
       VALUES ('old.txt', 'old.txt', 'oldsha256000000000000000000000000000000000000000000000000000000', 1, 'text/plain', 'old.txt', 'hash1', 1000000)`,
    ).run();
    db.prepare(
      `INSERT INTO files (filename, original_name, sha256, size, content_type, gcs_key, token_hash, uploaded_at)
       VALUES ('new.txt', 'new.txt', 'newsha256000000000000000000000000000000000000000000000000000000', 1, 'text/plain', 'new.txt', 'hash2', 2000000)`,
    ).run();
    const files = listFiles();
    expect(files).toHaveLength(2);
    // First record should have the later uploaded_at
    expect(files[0].uploaded_at).toBeGreaterThan(files[1].uploaded_at);
    expect(files[0].original_name).toBe('new.txt');
  });
});

// ── updateFileExpiry ─────────────────────────────────────────────────────────

describe('updateFileExpiry', () => {
  it('sets a numeric expires_at', async () => {
    const { updateFileExpiry, getFileById } = await import('@/lib/db');
    const fileId = await insertTestFile();
    updateFileExpiry(fileId, 9999999999);
    const file = getFileById(fileId);
    expect(file?.expires_at).toBe(9999999999);
  });

  it('clears expires_at to null', async () => {
    const { updateFileExpiry, getFileById } = await import('@/lib/db');
    const fileId = await insertTestFile({ expires_at: 1234567890 });
    updateFileExpiry(fileId, null);
    const file = getFileById(fileId);
    expect(file?.expires_at).toBeNull();
  });

  it('does not throw when the id does not exist (no-op UPDATE)', async () => {
    const { updateFileExpiry } = await import('@/lib/db');
    // Non-existent id — should silently do nothing
    expect(() => updateFileExpiry(999999, 1234567890)).not.toThrow();
  });
});

// ── deleteFile ───────────────────────────────────────────────────────────────

describe('deleteFile', () => {
  it('removes the file record from the database', async () => {
    const { deleteFile, getFileById } = await import('@/lib/db');
    const fileId = await insertTestFile();
    deleteFile(fileId);
    expect(getFileById(fileId)).toBeUndefined();
  });

  it('the deleted file no longer appears in listFiles()', async () => {
    const { deleteFile, listFiles } = await import('@/lib/db');
    const fileId = await insertTestFile();
    expect(listFiles()).toHaveLength(1);
    deleteFile(fileId);
    expect(listFiles()).toHaveLength(0);
  });

  it('cascades: download_log rows for the deleted file are removed', async () => {
    const { deleteFile, logDownload, getDb } = await import('@/lib/db');
    const fileId = await insertTestFile();
    logDownload(fileId);
    logDownload(fileId);
    deleteFile(fileId);
    const db = getDb();
    const count = db
      .prepare<[number], { 'COUNT(*)': number }>('SELECT COUNT(*) FROM download_logs WHERE file_id = ?')
      .get(fileId)!['COUNT(*)'];
    expect(count).toBe(0);
  });
});
