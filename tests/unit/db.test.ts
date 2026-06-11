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

  it('uses DELETE journal mode (safe for GCS FUSE mounts)', async () => {
    const { getDb } = await import('@/lib/db');
    const db = getDb();
    const row = db.pragma('journal_mode') as { journal_mode: string }[];
    expect(row[0].journal_mode).toBe('delete');
  });

  it('returns the same instance on repeated calls (singleton)', async () => {
    const { getDb } = await import('@/lib/db');
    const a = getDb();
    const b = getDb();
    expect(a).toBe(b);
  });
});

describe('insertFile / getFileBySha256 / getFileById', () => {
  it('insertFile round-trips through getFileBySha256', async () => {
    const { insertFile, getFileBySha256 } = await import('@/lib/db');
    const data = {
      filename: 'abc123.txt',
      original_name: 'hello.txt',
      sha256: 'abc123def456abc123def456abc12345abc123def456abc123def456abc12345',
      size: 11,
      content_type: 'text/plain',
      gcs_key: 'abc123def456abc123def456abc12345abc123def456abc123def456abc12345.txt',
      token_hash: '$2b$10$fakehashvalue',
      expires_at: null,
      uploaded_by: null,
    };
    const inserted = insertFile(data);
    expect(inserted.id).toBeGreaterThan(0);
    expect(inserted.sha256).toBe(data.sha256);
    expect(inserted.filename).toBe(data.filename);

    const found = getFileBySha256(data.sha256);
    expect(found).toBeDefined();
    expect(found!.id).toBe(inserted.id);
    expect(found!.original_name).toBe('hello.txt');
  });

  it('getFileBySha256 returns undefined for unknown sha256', async () => {
    const { getFileBySha256 } = await import('@/lib/db');
    expect(getFileBySha256('nonexistent')).toBeUndefined();
  });

  it('getFileById returns the correct record', async () => {
    const { insertFile, getFileById } = await import('@/lib/db');
    const data = {
      filename: 'xyz789.txt',
      original_name: 'world.txt',
      sha256: 'xyz789000000xyz789000000xyz78900xyz789000000xyz789000000xyz78900',
      size: 5,
      content_type: 'text/plain',
      gcs_key: 'xyz789000000xyz789000000xyz78900xyz789000000xyz789000000xyz78900.txt',
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

describe('agent_device_sessions migration (user_version=4)', () => {
  it('creates the agent_device_sessions table', async () => {
    const { getDb } = await import('@/lib/db');
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('agent_device_sessions');
  });

  it('advances user_version to at least 4', async () => {
    const { getDb } = await import('@/lib/db');
    const db = getDb();
    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBeGreaterThanOrEqual(4);
  });

  it('table has the expected columns with poll_token_hash as primary key', async () => {
    const { getDb } = await import('@/lib/db');
    const db = getDb();
    const cols = db
      .prepare("SELECT name, pk FROM pragma_table_info('agent_device_sessions')")
      .all() as { name: string; pk: number }[];
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'poll_token_hash',
        'device_code',
        'interval',
        'expires_at',
        'created_at',
      ]),
    );
    const pk = cols.find((c) => c.name === 'poll_token_hash');
    expect(pk?.pk).toBe(1);
  });
});

describe('device session helpers', () => {
  const FUTURE = Math.floor(Date.now() / 1000) + 3600;

  it('createDeviceSession round-trips through getDeviceSessionByPollTokenHash', async () => {
    const { createDeviceSession, getDeviceSessionByPollTokenHash } = await import('@/lib/db');
    const created = createDeviceSession({
      poll_token_hash: 'hash-abc',
      device_code: 'device-code-xyz',
      interval: 5,
      expires_at: FUTURE,
    });
    expect(created.poll_token_hash).toBe('hash-abc');
    expect(created.device_code).toBe('device-code-xyz');
    expect(created.interval).toBe(5);
    expect(created.expires_at).toBe(FUTURE);
    expect(created.created_at).toBeGreaterThan(0);

    const found = getDeviceSessionByPollTokenHash('hash-abc');
    expect(found).toBeDefined();
    expect(found!.device_code).toBe('device-code-xyz');
  });

  it('getDeviceSessionByPollTokenHash returns undefined for unknown hash', async () => {
    const { getDeviceSessionByPollTokenHash } = await import('@/lib/db');
    expect(getDeviceSessionByPollTokenHash('nope')).toBeUndefined();
  });

  it('updateDeviceSessionInterval updates only the interval', async () => {
    const { createDeviceSession, updateDeviceSessionInterval, getDeviceSessionByPollTokenHash } =
      await import('@/lib/db');
    createDeviceSession({
      poll_token_hash: 'hash-upd',
      device_code: 'dc',
      interval: 5,
      expires_at: FUTURE,
    });
    updateDeviceSessionInterval('hash-upd', 10);
    const found = getDeviceSessionByPollTokenHash('hash-upd');
    expect(found!.interval).toBe(10);
    expect(found!.device_code).toBe('dc');
    expect(found!.expires_at).toBe(FUTURE);
  });

  it('deleteDeviceSession removes the row', async () => {
    const { createDeviceSession, deleteDeviceSession, getDeviceSessionByPollTokenHash } =
      await import('@/lib/db');
    createDeviceSession({
      poll_token_hash: 'hash-del',
      device_code: 'dc',
      interval: 5,
      expires_at: FUTURE,
    });
    deleteDeviceSession('hash-del');
    expect(getDeviceSessionByPollTokenHash('hash-del')).toBeUndefined();
  });

  it('getExpiredDeviceSessions returns only sessions past expires_at', async () => {
    const { createDeviceSession, getExpiredDeviceSessions } = await import('@/lib/db');
    const past = Math.floor(Date.now() / 1000) - 60;
    createDeviceSession({
      poll_token_hash: 'hash-expired',
      device_code: 'dc-old',
      interval: 5,
      expires_at: past,
    });
    createDeviceSession({
      poll_token_hash: 'hash-fresh',
      device_code: 'dc-new',
      interval: 5,
      expires_at: FUTURE,
    });
    const expired = getExpiredDeviceSessions();
    const hashes = expired.map((s) => s.poll_token_hash);
    expect(hashes).toContain('hash-expired');
    expect(hashes).not.toContain('hash-fresh');
  });
});
