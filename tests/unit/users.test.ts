import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileshare-users-test-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
});

afterEach(async () => {
  const mod = await import('@/lib/db');
  mod._resetDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

/** Insert a minimal test user and return the created User */
async function insertTestUser(overrides: {
  username?: string;
  password_hash?: string;
  permissions?: string[];
} = {}) {
  const { createUser } = await import('@/lib/db');
  return createUser({
    username: overrides.username ?? 'alice',
    password_hash: overrides.password_hash ?? '$2b$10$fakehash',
    permissions: (overrides.permissions ?? ['upload']) as import('@/types').Permission[],
  });
}

// ── listUsers ────────────────────────────────────────────────────────────────

describe('listUsers', () => {
  it('returns an empty array when no users exist', async () => {
    const { listUsers } = await import('@/lib/db');
    expect(listUsers()).toEqual([]);
  });

  it('returns one user after inserting one', async () => {
    const { listUsers } = await import('@/lib/db');
    const user = await insertTestUser();
    const result = listUsers();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(user.id);
    expect(result[0].username).toBe('alice');
    expect(result[0].permissions).toEqual(['upload']);
  });

  it('returns multiple users ordered by id ASC', async () => {
    const { listUsers } = await import('@/lib/db');
    const u1 = await insertTestUser({ username: 'alice' });
    const u2 = await insertTestUser({ username: 'bob', permissions: ['admin'] });
    const result = listUsers();
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(u1.id);
    expect(result[1].id).toBe(u2.id);
  });
});

// ── createUser ───────────────────────────────────────────────────────────────

describe('createUser', () => {
  it('round-trips username and permissions correctly', async () => {
    const { createUser, getUserById } = await import('@/lib/db');
    const user = createUser({
      username: 'charlie',
      password_hash: '$2b$10$fakehash',
      permissions: ['upload', 'admin'],
    });
    expect(user.username).toBe('charlie');
    expect(user.permissions).toEqual(['upload', 'admin']);
    const fetched = getUserById(user.id);
    expect(fetched).toBeDefined();
    expect(fetched!.username).toBe('charlie');
    expect(fetched!.permissions).toEqual(['upload', 'admin']);
  });

  it('assigns a numeric id to the created user', async () => {
    const { createUser } = await import('@/lib/db');
    const user = createUser({
      username: 'dave',
      password_hash: '$2b$10$fakehash',
      permissions: [],
    });
    expect(typeof user.id).toBe('number');
    expect(user.id).toBeGreaterThan(0);
  });

  it('throws on duplicate username (UNIQUE constraint)', async () => {
    const { createUser } = await import('@/lib/db');
    createUser({ username: 'eve', password_hash: '$2b$10$fakehash', permissions: [] });
    expect(() =>
      createUser({ username: 'eve', password_hash: '$2b$10$fakehash2', permissions: [] }),
    ).toThrow();
  });
});

// ── updateUser ───────────────────────────────────────────────────────────────

describe('updateUser', () => {
  it('updates username', async () => {
    const { updateUser, getUserById } = await import('@/lib/db');
    const user = await insertTestUser();
    updateUser(user.id, { username: 'alice2' });
    const updated = getUserById(user.id);
    expect(updated?.username).toBe('alice2');
  });

  it('updates permissions and parses them back as an array', async () => {
    const { updateUser, getUserById } = await import('@/lib/db');
    const user = await insertTestUser();
    updateUser(user.id, { permissions: ['admin'] });
    const updated = getUserById(user.id);
    expect(updated?.permissions).toEqual(['admin']);
  });

  it('updates password_hash', async () => {
    const { updateUser, getUserById } = await import('@/lib/db');
    const user = await insertTestUser();
    updateUser(user.id, { password_hash: '$2b$10$newhash' });
    const updated = getUserById(user.id);
    expect(updated?.password_hash).toBe('$2b$10$newhash');
  });

  it('is a no-op when patch is empty', async () => {
    const { updateUser, getUserById } = await import('@/lib/db');
    const user = await insertTestUser();
    expect(() => updateUser(user.id, {})).not.toThrow();
    const after = getUserById(user.id);
    expect(after?.username).toBe('alice');
    expect(after?.permissions).toEqual(['upload']);
  });

  it('does not throw when id does not exist (no-op UPDATE)', async () => {
    const { updateUser } = await import('@/lib/db');
    expect(() => updateUser(999999, { username: 'ghost' })).not.toThrow();
  });
});

// ── deleteUser ───────────────────────────────────────────────────────────────

describe('deleteUser', () => {
  it('removes the user from the database', async () => {
    const { deleteUser, getUserById } = await import('@/lib/db');
    const user = await insertTestUser();
    deleteUser(user.id);
    expect(getUserById(user.id)).toBeUndefined();
  });

  it('deleted user no longer appears in listUsers()', async () => {
    const { deleteUser, listUsers } = await import('@/lib/db');
    const user = await insertTestUser();
    expect(listUsers()).toHaveLength(1);
    deleteUser(user.id);
    expect(listUsers()).toHaveLength(0);
  });

  it('is a no-op when id does not exist', async () => {
    const { deleteUser } = await import('@/lib/db');
    expect(() => deleteUser(999999)).not.toThrow();
  });
});
