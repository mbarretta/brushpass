/**
 * Unit tests for:
 *   1. upsertOidcUser / getOidcUserByEmail DB helpers
 *   2. Migration guard (email + auth_provider columns present on fresh DB)
 *   3. jwtCallback domain auto-promote logic
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// next-auth calls NextRequest from "next/server" at module-load time, which
// doesn't exist in the Vitest (Node) environment. Mock the entire next-auth
// module so that `export const { handlers, auth, signIn, signOut } = NextAuth(config)`
// in src/auth.ts is a no-op. jwtCallback is a named export and does NOT use
// next-auth at runtime, so this mock is safe for testing it.
vi.mock('next-auth', () => ({
  default: (_config: unknown) => ({
    handlers: {},
    auth: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));

// ── Temp DB isolation ────────────────────────────────────────────────────────
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fileshare-oidc-test-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
});

afterEach(async () => {
  const mod = await import('@/lib/db');
  mod._resetDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
  delete process.env.AUTH_OIDC_ADMIN_DOMAIN;
  vi.restoreAllMocks();
  vi.resetModules();
});

// ── upsertOidcUser ────────────────────────────────────────────────────────────

describe('upsertOidcUser()', () => {
  it('inserts user on first call with correct email, auth_provider=oidc, and permissions', async () => {
    const { upsertOidcUser } = await import('@/lib/db');
    const user = upsertOidcUser('alice@chainguard.dev', 'Alice', ['upload', 'admin']);
    expect(user.email).toBe('alice@chainguard.dev');
    expect(user.auth_provider).toBe('oidc');
    expect(user.permissions).toEqual(['upload', 'admin']);
    expect(user.password_hash).toBeNull();
    expect(typeof user.id).toBe('number');
  });

  it('uses name as username on insert', async () => {
    const { upsertOidcUser } = await import('@/lib/db');
    const user = upsertOidcUser('bob@gmail.com', 'Bob Smith', []);
    expect(user.username).toBe('Bob Smith');
  });

  it('falls back to email as username when name is empty string', async () => {
    const { upsertOidcUser } = await import('@/lib/db');
    const user = upsertOidcUser('charlie@example.com', '', []);
    expect(user.username).toBe('charlie@example.com');
  });

  it('second call with different permissions is a no-op (INSERT OR IGNORE)', async () => {
    const { upsertOidcUser } = await import('@/lib/db');
    const first = upsertOidcUser('alice@chainguard.dev', 'Alice', ['upload', 'admin']);
    // Second call with empty permissions — should not change existing permissions
    const second = upsertOidcUser('alice@chainguard.dev', 'Alice', []);
    expect(second.id).toBe(first.id);
    expect(second.permissions).toEqual(['upload', 'admin']);
  });

  it('updateUser can change permissions after upsertOidcUser, and upsertOidcUser still does not overwrite', async () => {
    const { upsertOidcUser, updateUser, getUserById } = await import('@/lib/db');
    const user = upsertOidcUser('dave@example.com', 'Dave', []);

    // Admin manually grants permissions
    updateUser(user.id, { permissions: ['upload', 'admin'] });
    const after = getUserById(user.id);
    expect(after?.permissions).toEqual(['upload', 'admin']);

    // OIDC sign-in again with empty auto-permissions — must not overwrite
    const upserted = upsertOidcUser('dave@example.com', 'Dave', []);
    expect(upserted.permissions).toEqual(['upload', 'admin']);
  });
});

// ── getOidcUserByEmail ────────────────────────────────────────────────────────

describe('getOidcUserByEmail()', () => {
  it('returns undefined when user does not exist', async () => {
    const { getOidcUserByEmail } = await import('@/lib/db');
    expect(getOidcUserByEmail('nobody@example.com')).toBeUndefined();
  });

  it('returns the correct user after upsert', async () => {
    const { upsertOidcUser, getOidcUserByEmail } = await import('@/lib/db');
    upsertOidcUser('eve@test.com', 'Eve', ['upload']);
    const user = getOidcUserByEmail('eve@test.com');
    expect(user).toBeDefined();
    expect(user!.email).toBe('eve@test.com');
    expect(user!.permissions).toEqual(['upload']);
  });
});

// ── Migration guard ───────────────────────────────────────────────────────────

describe('migration guard: fresh DB has email and auth_provider columns', () => {
  it('pragma_table_info reports email and auth_provider on the users table', async () => {
    const { getDb } = await import('@/lib/db');
    const db = getDb();
    const colNames = new Set(
      (db.prepare("SELECT name FROM pragma_table_info('users')").all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    expect(colNames.has('email')).toBe(true);
    expect(colNames.has('auth_provider')).toBe(true);
  });
});

// ── jwtCallback — domain auto-promote logic ───────────────────────────────────
//
// We mock @/lib/db so that upsertOidcUser doesn't touch sqlite at all,
// then import jwtCallback from @/auth and exercise all four branches.

describe('jwtCallback()', () => {
  it('session refresh path: no user, no account → returns token unchanged', async () => {
    const { jwtCallback } = await import('@/auth');
    const token = { id: '7', username: 'alice', email: null, permissions: ['upload'] } as any;
    const result = await jwtCallback({ token });
    expect(result).toBe(token); // same reference
    expect(result.id).toBe('7');
  });

  it('credentials path: copies id/username/permissions, email from user', async () => {
    const { jwtCallback } = await import('@/auth');
    const token = {} as any;
    const user = { id: '3', username: 'bob', email: null, permissions: ['admin'] } as any;
    const account = { type: 'credentials' } as any;
    const result = await jwtCallback({ token, user, account });
    expect(result.id).toBe('3');
    expect(result.username).toBe('bob');
    expect(result.email).toBeNull();
    expect(result.permissions).toEqual(['admin']);
  });

  it('OIDC path + matching domain → auto_promote=true, permissions=[upload,admin]', async () => {
    process.env.AUTH_OIDC_ADMIN_DOMAIN = 'chainguard.dev';

    // Inline mock of upsertOidcUser — returns a DB user with auto-promoted permissions
    const mockUpsert = vi.fn().mockResolvedValue({
      id: 42,
      username: 'alice@chainguard.dev',
      email: 'alice@chainguard.dev',
      auth_provider: 'oidc',
      password_hash: null,
      permissions: ['upload', 'admin'],
      created_at: 1234567890,
    });

    vi.doMock('@/lib/db', async (importOriginal) => {
      const orig = await importOriginal<typeof import('@/lib/db')>();
      return { ...orig, upsertOidcUser: mockUpsert };
    });
    vi.resetModules();

    const { jwtCallback } = await import('@/auth');
    const token = {} as any;
    const user = { email: 'alice@chainguard.dev', name: 'Alice' } as any;
    const account = { type: 'oidc' } as any;

    const result = await jwtCallback({ token, user, account });

    expect(mockUpsert).toHaveBeenCalledWith(
      'alice@chainguard.dev',
      'Alice',
      ['upload', 'admin'],
    );
    expect(result.id).toBe('42');
    expect(result.username).toBe('alice@chainguard.dev');
    expect(result.email).toBe('alice@chainguard.dev');
    expect(result.permissions).toEqual(['upload', 'admin']);
  });

  it('OIDC path + non-matching domain → auto_promote=false, permissions=[]', async () => {
    process.env.AUTH_OIDC_ADMIN_DOMAIN = 'chainguard.dev';

    const mockUpsert = vi.fn().mockResolvedValue({
      id: 99,
      username: 'bob@gmail.com',
      email: 'bob@gmail.com',
      auth_provider: 'oidc',
      password_hash: null,
      permissions: [],
      created_at: 1234567890,
    });

    vi.doMock('@/lib/db', async (importOriginal) => {
      const orig = await importOriginal<typeof import('@/lib/db')>();
      return { ...orig, upsertOidcUser: mockUpsert };
    });
    vi.resetModules();

    const { jwtCallback } = await import('@/auth');
    const token = {} as any;
    const user = { email: 'bob@gmail.com', name: 'Bob' } as any;
    const account = { type: 'oidc' } as any;

    const result = await jwtCallback({ token, user, account });

    expect(mockUpsert).toHaveBeenCalledWith('bob@gmail.com', 'Bob', []);
    expect(result.id).toBe('99');
    expect(result.permissions).toEqual([]);
  });
});
