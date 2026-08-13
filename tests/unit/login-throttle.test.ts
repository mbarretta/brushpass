/**
 * Unit tests for authorizeCredentials (src/auth.ts) — the one place every
 * credentials login converges, whatever transport carried it.
 *
 * Covers:
 *  - ac2: failed-attempt lockout lives INSIDE authorize and is keyed on both the
 *    username and the client IP, so five failures followed by the CORRECT
 *    password still return null.
 *  - ac3: exactly one bcrypt compare per attempt — an unknown username, an OIDC
 *    account with a null password_hash, and a wrong password are all
 *    indistinguishable by work done.
 *  - ac4: the IP key comes from the right-hand end of x-forwarded-for, so
 *    rotating the left-hand entry does not buy fresh attempts.
 *
 * next-auth is mocked because src/auth.ts calls NextAuth() at module scope;
 * bcryptjs is mocked so compares can be COUNTED (the real @/lib/token runs).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { User } from '@/types';

vi.mock('next-auth', () => ({
  default: () => ({ handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }),
}));

vi.mock('next-auth/providers/credentials', () => ({
  default: (config: unknown) => config,
}));

vi.mock('@/lib/db', () => ({
  getUserByUsernameForAuth: vi.fn(),
}));

vi.mock('bcryptjs', () => ({
  default: {
    compare: vi.fn(),
    hash: vi.fn(),
  },
}));

const REAL_PASSWORD = 'correct-horse-battery';
const STORED_HASH = '$2b$10$storedhashvalue00000000000000000000000000000000000000';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 42,
    username: 'alice',
    password_hash: STORED_HASH,
    email: 'alice@example.com',
    auth_provider: 'credentials',
    permissions: ['upload'],
    created_at: 1700000000,
    ...overrides,
  };
}

/** A request whose headers carry `xff` as x-forwarded-for. */
function requestFrom(xff: string): { headers: { get(name: string): string | null } } {
  return {
    headers: {
      get: (name: string) => (name.toLowerCase() === 'x-forwarded-for' ? xff : null),
    },
  };
}

/** bcrypt.compare returns true only for the real password against the real hash. */
async function stubBcrypt(): Promise<ReturnType<typeof vi.fn>> {
  const bcrypt = (await import('bcryptjs')).default;
  const compare = vi.mocked(bcrypt.compare) as unknown as ReturnType<typeof vi.fn>;
  compare.mockImplementation(async (candidate: string, hash: string) =>
    candidate === REAL_PASSWORD && hash === STORED_HASH,
  );
  return compare;
}

/** Loads a FRESH module graph so each case starts with empty throttle maps. */
async function loadAuth() {
  vi.resetModules();
  const compare = await stubBcrypt();
  const db = await import('@/lib/db');
  const { authorizeCredentials } = await import('@/auth');
  return { authorizeCredentials, db, compare };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('authorizeCredentials() — lockout', () => {
  it('returns null for the CORRECT password once the username has 5 failures (ac2)', async () => {
    const { authorizeCredentials, db, compare } = await loadAuth();
    vi.mocked(db.getUserByUsernameForAuth).mockReturnValue(makeUser());
    const request = requestFrom('9.9.9.9');

    for (let i = 0; i < 5; i++) {
      const attempt = await authorizeCredentials(
        { username: 'alice', password: `guess-${i}` },
        request,
      );
      expect(attempt).toBeNull();
    }
    expect(compare).toHaveBeenCalledTimes(5);

    // The right password now, and it must STILL be refused.
    const afterLockout = await authorizeCredentials(
      { username: 'alice', password: REAL_PASSWORD },
      request,
    );
    expect(afterLockout).toBeNull();
    // No bcrypt work is spent while locked out, and hammering does not extend it.
    expect(compare).toHaveBeenCalledTimes(5);
  });

  it('is keyed on the username, so switching IP does not unlock it (ac2)', async () => {
    const { authorizeCredentials, db } = await loadAuth();
    vi.mocked(db.getUserByUsernameForAuth).mockReturnValue(makeUser());

    for (let i = 0; i < 5; i++) {
      await authorizeCredentials({ username: 'alice', password: 'wrong' }, requestFrom(`9.9.9.${i}`));
    }

    const fromNewIp = await authorizeCredentials(
      { username: 'alice', password: REAL_PASSWORD },
      requestFrom('4.4.4.4'),
    );
    expect(fromNewIp).toBeNull();
  });

  it('does not lock a different username out when one account is being guessed', async () => {
    const { authorizeCredentials, db } = await loadAuth();
    vi.mocked(db.getUserByUsernameForAuth).mockImplementation((username: string) =>
      username === 'alice' ? makeUser() : makeUser({ id: 43, username: 'bob' }),
    );

    for (let i = 0; i < 5; i++) {
      await authorizeCredentials({ username: 'alice', password: 'wrong' }, requestFrom('9.9.9.9'));
    }

    const bob = await authorizeCredentials(
      { username: 'bob', password: REAL_PASSWORD },
      requestFrom('9.9.9.9'),
    );
    expect(bob).not.toBeNull();
    expect(bob?.username).toBe('bob');
  });

  it('locks the client IP after 20 failures even when the username rotates (ac2)', async () => {
    const { authorizeCredentials, db } = await loadAuth();
    vi.mocked(db.getUserByUsernameForAuth).mockReturnValue(undefined);

    for (let i = 0; i < 20; i++) {
      await authorizeCredentials({ username: `victim-${i}`, password: 'guess' }, requestFrom('9.9.9.9'));
    }

    // A fresh username from the same IP: real user, real password, still refused.
    vi.mocked(db.getUserByUsernameForAuth).mockReturnValue(makeUser());
    const stuffed = await authorizeCredentials(
      { username: 'alice', password: REAL_PASSWORD },
      requestFrom('9.9.9.9'),
    );
    expect(stuffed).toBeNull();

    // Another IP is unaffected.
    const elsewhere = await authorizeCredentials(
      { username: 'alice', password: REAL_PASSWORD },
      requestFrom('5.5.5.5'),
    );
    expect(elsewhere).not.toBeNull();
  });

  it('cannot be evaded by rotating the left-hand x-forwarded-for entry (ac4)', async () => {
    const { authorizeCredentials, db } = await loadAuth();
    vi.mocked(db.getUserByUsernameForAuth).mockReturnValue(undefined);

    for (let i = 0; i < 20; i++) {
      await authorizeCredentials(
        { username: `victim-${i}`, password: 'guess' },
        // A fresh spoofed left entry every time; the trusted right entry is fixed.
        requestFrom(`10.0.0.${i}, 9.9.9.9`),
      );
    }

    vi.mocked(db.getUserByUsernameForAuth).mockReturnValue(makeUser());
    const stillLocked = await authorizeCredentials(
      { username: 'alice', password: REAL_PASSWORD },
      requestFrom('10.0.0.99, 9.9.9.9'),
    );
    expect(stillLocked).toBeNull();
  });

  it('clears the counters after a successful login', async () => {
    const { authorizeCredentials, db } = await loadAuth();
    vi.mocked(db.getUserByUsernameForAuth).mockReturnValue(makeUser());
    const request = requestFrom('9.9.9.9');

    for (let i = 0; i < 4; i++) {
      await authorizeCredentials({ username: 'alice', password: 'wrong' }, request);
    }
    expect(await authorizeCredentials({ username: 'alice', password: REAL_PASSWORD }, request)).not.toBeNull();

    // Budget is reset: four more failures still do not lock the account.
    for (let i = 0; i < 4; i++) {
      await authorizeCredentials({ username: 'alice', password: 'wrong' }, request);
    }
    expect(await authorizeCredentials({ username: 'alice', password: REAL_PASSWORD }, request)).not.toBeNull();
  });
});

describe('authorizeCredentials() — constant work (ac3)', () => {
  it('spends exactly one bcrypt compare on an unknown username', async () => {
    const { authorizeCredentials, db, compare } = await loadAuth();
    vi.mocked(db.getUserByUsernameForAuth).mockReturnValue(undefined);

    const result = await authorizeCredentials(
      { username: 'nobody', password: 'whatever' },
      requestFrom('9.9.9.9'),
    );

    expect(result).toBeNull();
    expect(compare).toHaveBeenCalledTimes(1);
    // Against the fixed dummy hash, not the caller's input.
    expect(compare.mock.calls[0][1]).toMatch(/^\$2[aby]\$\d{2}\$/);
  });

  it('spends exactly one bcrypt compare on a wrong password', async () => {
    const { authorizeCredentials, db, compare } = await loadAuth();
    vi.mocked(db.getUserByUsernameForAuth).mockReturnValue(makeUser());

    const result = await authorizeCredentials(
      { username: 'alice', password: 'wrong' },
      requestFrom('9.9.9.9'),
    );

    expect(result).toBeNull();
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare.mock.calls[0][1]).toBe(STORED_HASH);
  });

  it('spends exactly one bcrypt compare for an OIDC account with no password_hash', async () => {
    const { authorizeCredentials, db, compare } = await loadAuth();
    vi.mocked(db.getUserByUsernameForAuth).mockReturnValue(
      makeUser({ auth_provider: 'oidc', password_hash: null }),
    );

    const result = await authorizeCredentials(
      { username: 'alice', password: REAL_PASSWORD },
      requestFrom('9.9.9.9'),
    );

    // Credentials login must never succeed for an SSO account...
    expect(result).toBeNull();
    // ...and must not be a fast path that reveals the account is SSO-backed.
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare.mock.calls[0][1]).toMatch(/^\$2[aby]\$\d{2}\$/);
  });

  it('returns the actor with DB permissions on a correct password', async () => {
    const { authorizeCredentials, db, compare } = await loadAuth();
    vi.mocked(db.getUserByUsernameForAuth).mockReturnValue(makeUser({ permissions: ['upload', 'admin'] }));

    const actor = await authorizeCredentials(
      { username: 'alice', password: REAL_PASSWORD },
      requestFrom('9.9.9.9'),
    );

    expect(actor).toEqual({
      id: '42',
      username: 'alice',
      email: 'alice@example.com',
      permissions: ['upload', 'admin'],
      name: 'alice',
    });
    expect(compare).toHaveBeenCalledTimes(1);
  });

  it('short-circuits missing credentials without a compare or a DB read', async () => {
    const { authorizeCredentials, db, compare } = await loadAuth();

    expect(await authorizeCredentials({ username: '', password: 'x' }, requestFrom('9.9.9.9'))).toBeNull();
    expect(await authorizeCredentials({ username: 'alice' }, requestFrom('9.9.9.9'))).toBeNull();
    expect(await authorizeCredentials(undefined, requestFrom('9.9.9.9'))).toBeNull();

    expect(compare).not.toHaveBeenCalled();
    expect(vi.mocked(db.getUserByUsernameForAuth)).not.toHaveBeenCalled();
  });

  it('still applies the lockout when no request (and therefore no IP) is available', async () => {
    // The provider always receives a request in v5, but the username dimension
    // must not depend on that.
    const { authorizeCredentials, db } = await loadAuth();
    vi.mocked(db.getUserByUsernameForAuth).mockReturnValue(makeUser());

    for (let i = 0; i < 5; i++) {
      await authorizeCredentials({ username: 'alice', password: 'wrong' });
    }
    expect(await authorizeCredentials({ username: 'alice', password: REAL_PASSWORD })).toBeNull();
  });

  it('does not lump callers with an unresolvable IP into one shared counter', async () => {
    // With no x-forwarded-for (local dev, or a header-stripping proxy) there is
    // no IP identity, so failures against many usernames must not lock out an
    // unrelated user the way a shared 'unknown' bucket would.
    const { authorizeCredentials, db } = await loadAuth();
    const noIp = { headers: { get: () => null } };
    vi.mocked(db.getUserByUsernameForAuth).mockReturnValue(undefined);

    for (let i = 0; i < 25; i++) {
      await authorizeCredentials({ username: `victim-${i}`, password: 'guess' }, noIp);
    }

    vi.mocked(db.getUserByUsernameForAuth).mockReturnValue(makeUser());
    const legitimate = await authorizeCredentials(
      { username: 'alice', password: REAL_PASSWORD },
      noIp,
    );
    expect(legitimate).not.toBeNull();
  });
});
