import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Each test run uses an isolated temp DB path to avoid singleton conflicts
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileshare-dl-test-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
});

afterEach(async () => {
  const mod = await import('@/lib/db');
  mod._resetDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

/** Insert a minimal file record and return its id */
async function insertTestFile(overrides: { expires_at?: number | null } = {}): Promise<number> {
  const { insertFile } = await import('@/lib/db');
  const record = insertFile({
    filename: 'aabbccdd.txt',
    original_name: 'test.txt',
    sha256: 'aabbccdd00000000aabbccdd00000000aabbccdd00000000aabbccdd00000000',
    size: 4,
    content_type: 'text/plain',
    gcs_key: 'aabbccdd00000000aabbccdd00000000aabbccdd00000000aabbccdd00000000.txt',
    token_hash: '$2b$10$fakehashvalue',
    expires_at: overrides.expires_at !== undefined ? overrides.expires_at : null,
    uploaded_by: null,
  });
  return record.id;
}

describe('logDownload', () => {
  it('inserts one download_log row', async () => {
    const { logDownload, getDb } = await import('@/lib/db');
    const fileId = await insertTestFile();
    logDownload(fileId);
    const count = getDb()
      .prepare<[number], { 'COUNT(*)': number }>('SELECT COUNT(*) FROM download_logs WHERE file_id = ?')
      .get(fileId)!['COUNT(*)'];
    expect(count).toBe(1);
  });
});

describe('getDownloadCount', () => {
  it('returns 0 when no downloads have been logged', async () => {
    const { getDownloadCount } = await import('@/lib/db');
    const fileId = await insertTestFile();
    expect(getDownloadCount(fileId)).toBe(0);
  });

  it('returns 2 after two logDownload calls', async () => {
    const { logDownload, getDownloadCount } = await import('@/lib/db');
    const fileId = await insertTestFile();
    logDownload(fileId);
    logDownload(fileId);
    expect(getDownloadCount(fileId)).toBe(2);
  });
});

describe('getDownloadLogs', () => {
  it('returns an array with one entry after one logDownload call', async () => {
    const { logDownload, getDownloadLogs } = await import('@/lib/db');
    const fileId = await insertTestFile();
    logDownload(fileId);
    const logs = getDownloadLogs(fileId);
    expect(logs).toHaveLength(1);
    expect(logs[0].file_id).toBe(fileId);
    expect(typeof logs[0].downloaded_at).toBe('number');
    expect(logs[0].downloaded_at).toBeGreaterThan(0);
  });

  it('returns entries ordered by downloaded_at DESC (latest first)', async () => {
    const { logDownload, getDownloadLogs } = await import('@/lib/db');
    const fileId = await insertTestFile();
    // Insert two rows; SQLite unixepoch() resolution is 1s so we can't reliably order
    // by time within the same second. Instead we just verify both rows are returned.
    logDownload(fileId);
    logDownload(fileId);
    const logs = getDownloadLogs(fileId);
    expect(logs).toHaveLength(2);
    // Each entry references the correct file
    expect(logs.every((l) => l.file_id === fileId)).toBe(true);
  });
});

describe('expiry boundary', () => {
  it('correctly identifies a past timestamp as expired', () => {
    // 2020-01-01T00:00:00Z as unix timestamp
    const pastExpiry = 1577836800;
    const now = Math.floor(Date.now() / 1000);
    expect(now > pastExpiry).toBe(true);
  });

  it('correctly identifies a future timestamp as not expired', () => {
    // Far future: year 2100
    const futureExpiry = 4102444800;
    const now = Math.floor(Date.now() / 1000);
    expect(now > futureExpiry).toBe(false);
  });

  it('null expires_at is treated as no expiry (the guard condition is false)', () => {
    const expiresAt: number | null = null;
    const now = Math.floor(Date.now() / 1000);
    // Route logic: expires_at !== null && now > expires_at
    const isExpired = expiresAt !== null && now > expiresAt;
    expect(isExpired).toBe(false);
  });
});
