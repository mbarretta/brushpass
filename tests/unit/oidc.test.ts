/**
 * Unit tests for:
 *   1. upsertOidcUser / getOidcUserByEmail DB helpers
 *   2. Migration guard (email + auth_provider columns present on fresh DB)
 *   3. emailDomain() claim parsing (src/lib/oidc-claims.ts)
 *   4. resolveOidcUserPermissions / jwtCallback / signInCallback — ac5: the
 *      email_verified requirement, the hd claim as an alternative domain source,
 *      and the double-@ address that must never auto-promote.
 *
 * Every stub here is typed against the real signature it stands in for — no
 * `any` — using the `vi.mocked` / `vi.fn<typeof fn>` pattern documented in
 * tests/unit/permission-requests-route.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import type { JWT } from '@auth/core/jwt';
import type { Account, Profile, User as NextAuthUser } from 'next-auth';
import type { Permission, SafeUser } from '@/types';

// next-auth calls NextRequest from "next/server" at module-load time, which
// doesn't exist in the Vitest (Node) environment. Mock the entire next-auth
// module so that `export const { handlers, auth, signIn, signOut } = NextAuth(config)`
// in src/auth.ts is a no-op. The exported callbacks under test do NOT use
// next-auth at runtime, so this mock is safe for testing them.
vi.mock('next-auth', () => ({
  default: () => ({
    handlers: {},
    auth: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));

// ── Typed fixtures ───────────────────────────────────────────────────────────

type UpsertOidcUser = typeof import('@/lib/db')['upsertOidcUser'];

/** A users row as upsertOidcUser would return it. */
function makeSafeUser(overrides: Partial<SafeUser> = {}): SafeUser {
  return {
    id: 42,
    username: 'alice@chainguard.dev',
    email: 'alice@chainguard.dev',
    auth_provider: 'oidc',
    permissions: [],
    created_at: 1234567890,
    ...overrides,
  };
}

/**
 * Replaces @/lib/db's upsertOidcUser with a typed stub returning `user`, then
 * resets the module registry so the next `import('@/auth')` picks it up.
 */
async function mockUpsertReturning(user: SafeUser): Promise<Mock<UpsertOidcUser>> {
  const mockUpsert = vi.fn<UpsertOidcUser>(() => user);
  vi.doMock('@/lib/db', async (importOriginal) => {
    const orig = await importOriginal<typeof import('@/lib/db')>();
    return { ...orig, upsertOidcUser: mockUpsert };
  });
  vi.resetModules();
  return mockUpsert;
}

/** A JWT with every augmented field present, so no cast is needed. */
function makeToken(overrides: Partial<JWT> = {}): JWT {
  return { id: '', username: '', email: null, permissions: [], ...overrides };
}

/** The `user` argument Auth.js passes to the jwt callback. */
function makeUser(overrides: Partial<NextAuthUser> = {}): NextAuthUser {
  return {
    id: '3',
    username: 'bob',
    email: null,
    permissions: [] as Permission[],
    ...overrides,
  };
}

/** The `account` argument, whose `type` selects the branch under test. */
function makeAccount(type: Account['type']): Account {
  return { provider: type === 'oidc' ? 'oidc' : 'credentials', providerAccountId: 'sub-1', type };
}

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
    const { upsertOidcUser, getDb } = await import('@/lib/db');
    const user = upsertOidcUser('alice@chainguard.dev', 'Alice', ['upload', 'admin']);
    expect(user.email).toBe('alice@chainguard.dev');
    expect(user.auth_provider).toBe('oidc');
    expect(user.permissions).toEqual(['upload', 'admin']);
    expect(typeof user.id).toBe('number');
    // upsertOidcUser() no longer selects password_hash — read it straight from the row.
    const row = getDb()
      .prepare<[number], { password_hash: string | null }>('SELECT password_hash FROM users WHERE id = ?')
      .get(user.id);
    expect(row?.password_hash).toBeNull();
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

// ── emailDomain — the claim parser behind the admin-domain rule ────────────────

describe('emailDomain()', () => {
  it('returns the lower-cased domain of a well-formed address', async () => {
    const { emailDomain } = await import('@/lib/oidc-claims');
    expect(emailDomain('alice@chainguard.dev')).toBe('chainguard.dev');
    expect(emailDomain('  Alice@Chainguard.DEV  ')).toBe('chainguard.dev');
  });

  it('returns null unless there is exactly one @ with text on both sides', async () => {
    const { emailDomain } = await import('@/lib/oidc-claims');
    // The attack: split('@')[1] would answer 'example.com' here.
    expect(emailDomain('victim@example.com@attacker.io')).toBeNull();
    expect(emailDomain('nodomain')).toBeNull();
    expect(emailDomain('@chainguard.dev')).toBeNull();
    expect(emailDomain('alice@')).toBeNull();
    expect(emailDomain('')).toBeNull();
    expect(emailDomain('alice bob@chainguard.dev')).toBeNull();
    expect(emailDomain('alice@chainguard dev')).toBeNull();
  });
});

// ── signInCallback — the outer gate ───────────────────────────────────────────

describe('signInCallback()', () => {
  it('rejects an OIDC sign-in whose profile is not email_verified', async () => {
    const { signInCallback } = await import('@/auth');
    const account = makeAccount('oidc');

    expect(
      signInCallback({ account, profile: { email: 'a@chainguard.dev', email_verified: false } }),
    ).toBe(false);
    // Absent claim is treated exactly like false — no session either way.
    expect(signInCallback({ account, profile: { email: 'a@chainguard.dev' } })).toBe(false);
    expect(signInCallback({ account, profile: null })).toBe(false);
  });

  it('allows an OIDC sign-in whose profile is email_verified', async () => {
    const { signInCallback } = await import('@/auth');
    expect(
      signInCallback({
        account: makeAccount('oidc'),
        profile: { email: 'a@chainguard.dev', email_verified: true },
      }),
    ).toBe(true);
  });

  it('lets non-OIDC sign-ins through untouched (credentials has its own gate)', async () => {
    const { signInCallback } = await import('@/auth');
    expect(signInCallback({ account: makeAccount('credentials') })).toBe(true);
    expect(signInCallback({})).toBe(true);
  });
});

// ── jwtCallback — domain auto-promote logic ───────────────────────────────────
//
// @/lib/db is mocked so upsertOidcUser doesn't touch sqlite, then jwtCallback is
// imported from @/auth and every branch exercised.

describe('jwtCallback()', () => {
  it('session refresh path: no user, no account → returns token unchanged', async () => {
    const { jwtCallback } = await import('@/auth');
    const token = makeToken({ id: '7', username: 'alice', permissions: ['upload'] });
    const result = await jwtCallback({ token });
    expect(result).toBe(token); // same reference
    expect(result.id).toBe('7');
  });

  it('credentials path: copies id/username/permissions, email from user', async () => {
    const { jwtCallback } = await import('@/auth');
    const result = await jwtCallback({
      token: makeToken(),
      user: makeUser({ id: '3', username: 'bob', email: null, permissions: ['admin'] }),
      account: makeAccount('credentials'),
    });
    expect(result.id).toBe('3');
    expect(result.username).toBe('bob');
    expect(result.email).toBeNull();
    expect(result.permissions).toEqual(['admin']);
  });

  it('OIDC path + matching domain → auto_promote=true, permissions=[upload,admin]', async () => {
    process.env.AUTH_OIDC_ADMIN_DOMAIN = 'chainguard.dev';
    const mockUpsert = await mockUpsertReturning(
      makeSafeUser({ permissions: ['upload', 'admin'] }),
    );

    const { jwtCallback } = await import('@/auth');
    const result = await jwtCallback({
      token: makeToken(),
      user: makeUser({ email: 'alice@chainguard.dev', name: 'Alice' }),
      account: makeAccount('oidc'),
      profile: { email: 'alice@chainguard.dev', email_verified: true },
    });

    expect(mockUpsert).toHaveBeenCalledWith('alice@chainguard.dev', 'Alice', ['upload', 'admin']);
    expect(result.id).toBe('42');
    expect(result.username).toBe('alice@chainguard.dev');
    expect(result.email).toBe('alice@chainguard.dev');
    expect(result.permissions).toEqual(['upload', 'admin']);
  });

  it('OIDC path + non-matching domain → auto_promote=false, permissions=[]', async () => {
    process.env.AUTH_OIDC_ADMIN_DOMAIN = 'chainguard.dev';
    const mockUpsert = await mockUpsertReturning(
      makeSafeUser({ id: 99, username: 'bob@gmail.com', email: 'bob@gmail.com' }),
    );

    const { jwtCallback } = await import('@/auth');
    const result = await jwtCallback({
      token: makeToken(),
      user: makeUser({ email: 'bob@gmail.com', name: 'Bob' }),
      account: makeAccount('oidc'),
      profile: { email: 'bob@gmail.com', email_verified: true },
    });

    expect(mockUpsert).toHaveBeenCalledWith('bob@gmail.com', 'Bob', []);
    expect(result.id).toBe('99');
    expect(result.permissions).toEqual([]);
  });

  it('reads email_verified from the PROFILE, not from user: an unverified profile is refused', async () => {
    // The default profile mapper drops email_verified, so a check that looked at
    // `user` would silently see undefined and pass everything.
    process.env.AUTH_OIDC_ADMIN_DOMAIN = 'chainguard.dev';
    const mockUpsert = await mockUpsertReturning(makeSafeUser());

    const { jwtCallback } = await import('@/auth');
    await expect(
      jwtCallback({
        token: makeToken(),
        user: makeUser({ email: 'alice@chainguard.dev', name: 'Alice' }),
        account: makeAccount('oidc'),
        profile: { email: 'alice@chainguard.dev' },
      }),
    ).rejects.toThrow(/email_verified/);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('takes the email from user (already lower-cased) rather than the raw profile claim', async () => {
    // users.email UNIQUE is BINARY in SQLite, so upserting the raw claim could
    // create a second row for the same mailbox and make upsertOidcUser throw.
    process.env.AUTH_OIDC_ADMIN_DOMAIN = 'chainguard.dev';
    const mockUpsert = await mockUpsertReturning(
      makeSafeUser({ permissions: ['upload', 'admin'] }),
    );

    const { jwtCallback } = await import('@/auth');
    await jwtCallback({
      token: makeToken(),
      user: makeUser({ email: 'alice@chainguard.dev', name: 'Alice' }),
      account: makeAccount('oidc'),
      profile: { email: 'Alice@Chainguard.DEV', email_verified: true },
    });

    expect(mockUpsert).toHaveBeenCalledWith('alice@chainguard.dev', 'Alice', ['upload', 'admin']);
  });

  it('accepts the hd claim off the profile as an alternative domain source', async () => {
    process.env.AUTH_OIDC_ADMIN_DOMAIN = 'chainguard.dev';
    const mockUpsert = await mockUpsertReturning(
      makeSafeUser({ email: 'alice@alias.example', permissions: ['upload', 'admin'] }),
    );

    const { jwtCallback } = await import('@/auth');
    const result = await jwtCallback({
      token: makeToken(),
      user: makeUser({ email: 'alice@alias.example', name: 'Alice' }),
      account: makeAccount('oidc'),
      profile: { email: 'alice@alias.example', email_verified: true, hd: 'chainguard.dev' },
    });

    expect(mockUpsert).toHaveBeenCalledWith('alice@alias.example', 'Alice', ['upload', 'admin']);
    expect(result.permissions).toEqual(['upload', 'admin']);
  });
});

// ── resolveOidcUserPermissions — the single gate both login paths call ─────────

describe('resolveOidcUserPermissions()', () => {
  it('admin-domain claims → auto-promotes to [upload,admin] and upserts with those permissions', async () => {
    process.env.AUTH_OIDC_ADMIN_DOMAIN = 'chainguard.dev';
    const mockUpsert = await mockUpsertReturning(
      makeSafeUser({ id: 7, permissions: ['upload', 'admin'] }),
    );

    const { resolveOidcUserPermissions } = await import('@/auth');
    const resolved = await resolveOidcUserPermissions({
      email: 'alice@chainguard.dev',
      name: 'Alice',
      email_verified: true,
    });

    expect(mockUpsert).toHaveBeenCalledWith('alice@chainguard.dev', 'Alice', ['upload', 'admin']);
    expect(resolved.id).toBe(7);
    expect(resolved.email).toBe('alice@chainguard.dev');
    expect(resolved.permissions).toEqual(['upload', 'admin']);
  });

  it('non-admin-domain claims → no auto-promote, upserts with [] permissions', async () => {
    process.env.AUTH_OIDC_ADMIN_DOMAIN = 'chainguard.dev';
    const mockUpsert = await mockUpsertReturning(
      makeSafeUser({ id: 8, username: 'bob@gmail.com', email: 'bob@gmail.com' }),
    );

    const { resolveOidcUserPermissions } = await import('@/auth');
    const resolved = await resolveOidcUserPermissions({
      email: 'bob@gmail.com',
      name: 'Bob',
      email_verified: true,
    });

    expect(mockUpsert).toHaveBeenCalledWith('bob@gmail.com', 'Bob', []);
    expect(resolved.id).toBe(8);
    expect(resolved.permissions).toEqual([]);
  });

  it('falls back to email as upsert name when claims.name is absent', async () => {
    process.env.AUTH_OIDC_ADMIN_DOMAIN = 'chainguard.dev';
    const mockUpsert = await mockUpsertReturning(
      makeSafeUser({ id: 9, username: 'carol@example.com', email: 'carol@example.com' }),
    );

    const { resolveOidcUserPermissions } = await import('@/auth');
    await resolveOidcUserPermissions({ email: 'carol@example.com', email_verified: true });

    expect(mockUpsert).toHaveBeenCalledWith('carol@example.com', 'carol@example.com', []);
  });

  it('does NOT auto-promote a double-@ address whose second field is the admin domain', async () => {
    // ac5's headline case: 'victim@example.com@attacker.io' must not be read as
    // belonging to example.com. The account may still exist, but with no rights.
    process.env.AUTH_OIDC_ADMIN_DOMAIN = 'example.com';
    const mockUpsert = await mockUpsertReturning(
      makeSafeUser({ id: 11, username: 'attacker', email: 'victim@example.com@attacker.io' }),
    );

    const { resolveOidcUserPermissions } = await import('@/auth');
    const resolved = await resolveOidcUserPermissions({
      email: 'victim@example.com@attacker.io',
      name: 'Attacker',
      email_verified: true,
    });

    expect(mockUpsert).toHaveBeenCalledWith(
      'victim@example.com@attacker.io',
      'Attacker',
      [],
    );
    expect(mockUpsert).not.toHaveBeenCalledWith(
      'victim@example.com@attacker.io',
      'Attacker',
      ['upload', 'admin'],
    );
    expect(resolved.permissions).toEqual([]);
  });

  it('does NOT auto-promote a double-@ address even when hd matches the admin domain', async () => {
    process.env.AUTH_OIDC_ADMIN_DOMAIN = 'example.com';
    const mockUpsert = await mockUpsertReturning(
      makeSafeUser({ id: 12, username: 'attacker', email: 'victim@example.com@attacker.io' }),
    );

    const { resolveOidcUserPermissions } = await import('@/auth');
    await resolveOidcUserPermissions({
      email: 'victim@example.com@attacker.io',
      name: 'Attacker',
      email_verified: true,
      hd: 'example.com',
    });

    expect(mockUpsert).toHaveBeenCalledWith('victim@example.com@attacker.io', 'Attacker', []);
  });

  it('throws without upserting when email_verified is not exactly true', async () => {
    process.env.AUTH_OIDC_ADMIN_DOMAIN = 'chainguard.dev';
    const mockUpsert = await mockUpsertReturning(makeSafeUser());

    const { resolveOidcUserPermissions } = await import('@/auth');

    await expect(
      resolveOidcUserPermissions({ email: 'alice@chainguard.dev', email_verified: false }),
    ).rejects.toThrow(/email_verified/);
    await expect(
      resolveOidcUserPermissions({ email: 'alice@chainguard.dev' }),
    ).rejects.toThrow(/email_verified/);

    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('throws without upserting when there is no email claim at all', async () => {
    const mockUpsert = await mockUpsertReturning(makeSafeUser());

    const { resolveOidcUserPermissions } = await import('@/auth');
    await expect(resolveOidcUserPermissions({ email_verified: true })).rejects.toThrow(/email/);
    await expect(
      resolveOidcUserPermissions({ email: '   ', email_verified: true }),
    ).rejects.toThrow(/email/);

    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('matches the admin domain case-insensitively', async () => {
    process.env.AUTH_OIDC_ADMIN_DOMAIN = 'Chainguard.DEV';
    const mockUpsert = await mockUpsertReturning(
      makeSafeUser({ permissions: ['upload', 'admin'] }),
    );

    const { resolveOidcUserPermissions } = await import('@/auth');
    await resolveOidcUserPermissions({
      email: 'alice@CHAINGUARD.dev',
      name: 'Alice',
      email_verified: true,
    });

    expect(mockUpsert).toHaveBeenCalledWith('alice@CHAINGUARD.dev', 'Alice', ['upload', 'admin']);
  });

  it('never auto-promotes when AUTH_OIDC_ADMIN_DOMAIN is unset', async () => {
    delete process.env.AUTH_OIDC_ADMIN_DOMAIN;
    const mockUpsert = await mockUpsertReturning(makeSafeUser());

    const { resolveOidcUserPermissions } = await import('@/auth');
    await resolveOidcUserPermissions({
      email: 'alice@chainguard.dev',
      name: 'Alice',
      email_verified: true,
      hd: 'chainguard.dev',
    });

    expect(mockUpsert).toHaveBeenCalledWith('alice@chainguard.dev', 'Alice', []);
  });
});

// A compile-time guard: Profile is the type the callbacks actually receive, and
// the claims read off it (email_verified, hd) must remain assignable to it.
const _profileShape: Profile = { email: 'a@b.dev', email_verified: true, hd: 'b.dev' };
void _profileShape;
