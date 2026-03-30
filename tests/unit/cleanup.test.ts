import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileshare-cleanup-test-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
});

afterEach(async () => {
  const mod = await import('@/lib/db');
  mod._resetDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

// Minimal helper to insert a file row with a controlled expires_at
async function seedFile(
  md5: string,
  expiresAt: number | null,
): Promise<void> {
  const { insertFile } = await import('@/lib/db');
  insertFile({
    filename: `${md5}.txt`,
    original_name: 'test.txt',
    md5,
    size: 4,
    content_type: 'text/plain',
    gcs_key: `${md5}.txt`,
    token_hash: 'fakehash',
    expires_at: expiresAt,
    uploaded_by: null,
  });
}

// We need to manipulate expires_at directly to values in the past/future.
// better-sqlite3 lets us run raw SQL for that.
async function setExpiresAt(md5: string, value: number): Promise<void> {
  const { getDb } = await import('@/lib/db');
  const db = getDb();
  db.prepare('UPDATE files SET expires_at = ? WHERE md5 = ?').run(value, md5);
}

describe('getExpiredFiles()', () => {
  it('excludes records with null expires_at', async () => {
    const { getExpiredFiles } = await import('@/lib/db');
    await seedFile('aa000000000000000000000000000001', null);
    const results = getExpiredFiles();
    expect(results).toHaveLength(0);
  });

  it('excludes records with a future expires_at', async () => {
    const { getExpiredFiles } = await import('@/lib/db');
    // Insert with any value, then set to far future via raw SQL
    await seedFile('bb000000000000000000000000000001', 9999999999);
    const results = getExpiredFiles();
    expect(results).toHaveLength(0);
  });

  it('includes records with a past expires_at', async () => {
    const { getExpiredFiles } = await import('@/lib/db');
    await seedFile('cc000000000000000000000000000001', 1); // epoch second 1 — definitely in the past
    const results = getExpiredFiles();
    expect(results).toHaveLength(1);
    expect(results[0].md5).toBe('cc000000000000000000000000000001');
  });

  it('returns only past-expiry records when mixed', async () => {
    const { getExpiredFiles } = await import('@/lib/db');
    // past: expires_at = 1
    await seedFile('dd000000000000000000000000000001', 1);
    // null: never expires
    await seedFile('dd000000000000000000000000000002', null);
    // future
    await seedFile('dd000000000000000000000000000003', 9999999999);
    // another past
    await seedFile('dd000000000000000000000000000004', 2);

    const results = getExpiredFiles();
    expect(results).toHaveLength(2);
    const md5s = results.map((r) => r.md5);
    expect(md5s).toContain('dd000000000000000000000000000001');
    expect(md5s).toContain('dd000000000000000000000000000004');
    // Ordered by expires_at ASC
    expect(results[0].expires_at).toBeLessThan(results[1].expires_at!);
  });
});
