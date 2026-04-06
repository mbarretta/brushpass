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

// Minimal helper to insert a file row with a controlled expires_at.
// sha256 values are padded to 64 chars (the column's unique constraint requires it).
async function seedFile(
  sha256: string,
  expiresAt: number | null,
): Promise<void> {
  const { insertFile } = await import('@/lib/db');
  insertFile({
    filename: `${sha256}.txt`,
    original_name: 'test.txt',
    sha256,
    size: 4,
    content_type: 'text/plain',
    gcs_key: `${sha256}.txt`,
    token_hash: 'fakehash',
    expires_at: expiresAt,
    uploaded_by: null,
  });
}

async function setExpiresAt(sha256: string, value: number): Promise<void> {
  const { getDb } = await import('@/lib/db');
  const db = getDb();
  db.prepare('UPDATE files SET expires_at = ? WHERE sha256 = ?').run(value, sha256);
}

// Pad a short identifier to 64 chars for use as a sha256 value in tests
function pad64(s: string): string {
  return s.padEnd(64, '0');
}

describe('getExpiredFiles()', () => {
  it('excludes records with null expires_at', async () => {
    const { getExpiredFiles } = await import('@/lib/db');
    await seedFile(pad64('aa000000000000000000000000000001'), null);
    const results = getExpiredFiles();
    expect(results).toHaveLength(0);
  });

  it('excludes records with a future expires_at', async () => {
    const { getExpiredFiles } = await import('@/lib/db');
    await seedFile(pad64('bb000000000000000000000000000001'), 9999999999);
    const results = getExpiredFiles();
    expect(results).toHaveLength(0);
  });

  it('includes records with a past expires_at', async () => {
    const { getExpiredFiles } = await import('@/lib/db');
    const sha256 = pad64('cc000000000000000000000000000001');
    await seedFile(sha256, 1); // epoch second 1 — definitely in the past
    const results = getExpiredFiles();
    expect(results).toHaveLength(1);
    expect(results[0].sha256).toBe(sha256);
  });

  it('returns only past-expiry records when mixed', async () => {
    const { getExpiredFiles } = await import('@/lib/db');
    const s1 = pad64('dd000000000000000000000000000001');
    const s2 = pad64('dd000000000000000000000000000002');
    const s3 = pad64('dd000000000000000000000000000003');
    const s4 = pad64('dd000000000000000000000000000004');
    // past: expires_at = 1
    await seedFile(s1, 1);
    // null: never expires
    await seedFile(s2, null);
    // future
    await seedFile(s3, 9999999999);
    // another past
    await seedFile(s4, 2);

    const results = getExpiredFiles();
    expect(results).toHaveLength(2);
    const sha256s = results.map((r) => r.sha256);
    expect(sha256s).toContain(s1);
    expect(sha256s).toContain(s4);
    // Ordered by expires_at ASC
    expect(results[0].expires_at).toBeLessThan(results[1].expires_at!);
  });
});
