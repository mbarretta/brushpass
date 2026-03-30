import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Each test run uses an isolated temp DB path to avoid singleton conflicts
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileshare-auth-test-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
});

afterEach(async () => {
  const mod = await import('@/lib/db');
  mod._resetDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

describe('getUserByUsername()', () => {
  it('returns undefined for an unknown username', async () => {
    const { getUserByUsername } = await import('@/lib/db');
    expect(getUserByUsername('does-not-exist')).toBeUndefined();
  });

  it('returns user with permissions parsed as an array', async () => {
    const { getDb, getUserByUsername } = await import('@/lib/db');
    const db = getDb();
    db.prepare(
      `INSERT INTO users (username, password_hash, permissions)
       VALUES ('alice', '$2b$10$fakehash', '["upload","admin"]')`,
    ).run();

    const user = getUserByUsername('alice');
    expect(user).toBeDefined();
    expect(user!.username).toBe('alice');
    expect(Array.isArray(user!.permissions)).toBe(true);
    expect(user!.permissions).toContain('upload');
    expect(user!.permissions).toContain('admin');
  });

  it('returns user with empty permissions array when column is empty JSON array', async () => {
    const { getDb, getUserByUsername } = await import('@/lib/db');
    const db = getDb();
    db.prepare(
      `INSERT INTO users (username, password_hash, permissions)
       VALUES ('bob', '$2b$10$anotherhash', '[]')`,
    ).run();

    const user = getUserByUsername('bob');
    expect(user).toBeDefined();
    expect(user!.permissions).toEqual([]);
  });
});

describe('getUserById()', () => {
  it('returns undefined for an unknown id', async () => {
    const { getUserById } = await import('@/lib/db');
    expect(getUserById(99999)).toBeUndefined();
  });

  it('returns the correct user for a known id', async () => {
    const { getDb, getUserById } = await import('@/lib/db');
    const db = getDb();
    const result = db
      .prepare<[], { id: number }>(
        `INSERT INTO users (username, password_hash, permissions)
         VALUES ('charlie', '$2b$10$testhash', '["upload"]')
         RETURNING id`,
      )
      .get() as { id: number };

    const user = getUserById(result.id);
    expect(user).toBeDefined();
    expect(user!.username).toBe('charlie');
    expect(user!.permissions).toEqual(['upload']);
    expect(typeof user!.id).toBe('number');
  });
});
