/**
 * Unit tests for src/lib/admin-auth.ts — ac1: authorization is resolved from
 * the DATABASE by session.user.id, never from the JWT claim.
 *
 * The three cases that matter are a stale claim (JWT says admin, the row says
 * nothing), a deleted user (no row at all), and the happy path where the row
 * itself grants admin. `auth` is mocked because the real next-auth export needs
 * a request context; `@/lib/db` is mocked so each case can state exactly what
 * the users table currently holds.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { Session } from 'next-auth';
import type { SafeUser } from '@/types';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getUserById: vi.fn(),
}));

/**
 * Typed accessor for the mocked `auth()`. The real export is overloaded (plain
 * call / route wrap / middleware wrap) and vi.mocked() infers the whole overload
 * set, so narrow to the no-argument signature these helpers actually use — the
 * documented pattern from tests/unit/permission-requests-route.test.ts.
 */
async function mockedAuth(): Promise<Mock<() => Promise<Session | null>>> {
  const { auth } = await import('@/auth');
  return vi.mocked(auth) as unknown as Mock<() => Promise<Session | null>>;
}

/** A session asserting whatever the (possibly stale) JWT claim says. */
function sessionClaiming(id: string | undefined, permissions: string[]): Session {
  return { user: { id, username: 'alice', email: null, permissions }, expires: '' } as unknown as Session;
}

/** The users row the database currently holds for id 7. */
function row(permissions: SafeUser['permissions']): SafeUser {
  return {
    id: 7,
    username: 'alice',
    email: null,
    auth_provider: 'credentials',
    permissions,
    created_at: 1700000000,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('getIsAdmin()', () => {
  it('returns false when the JWT claims admin but the DB row grants nothing', async () => {
    (await mockedAuth()).mockResolvedValue(sessionClaiming('7', ['admin']));
    vi.mocked((await import('@/lib/db')).getUserById).mockReturnValue(row([]));

    const { getIsAdmin } = await import('@/lib/admin-auth');
    expect(await getIsAdmin()).toBe(false);
    // The claim only says WHICH row to read.
    expect(vi.mocked((await import('@/lib/db')).getUserById)).toHaveBeenCalledWith(7);
  });

  it('returns false for a session whose user has been deleted', async () => {
    (await mockedAuth()).mockResolvedValue(sessionClaiming('7', ['admin']));
    vi.mocked((await import('@/lib/db')).getUserById).mockReturnValue(undefined);

    const { getIsAdmin } = await import('@/lib/admin-auth');
    expect(await getIsAdmin()).toBe(false);
  });

  it('returns true when the DB row itself grants admin', async () => {
    (await mockedAuth()).mockResolvedValue(sessionClaiming('7', []));
    vi.mocked((await import('@/lib/db')).getUserById).mockReturnValue(row(['upload', 'admin']));

    const { getIsAdmin } = await import('@/lib/admin-auth');
    // Note the inverse of the stale-claim case: an EMPTY claim with an admin row
    // is still admin, because the row is the authority.
    expect(await getIsAdmin()).toBe(true);
  });

  it('returns false with no session at all, without touching the DB', async () => {
    (await mockedAuth()).mockResolvedValue(null);

    const { getIsAdmin } = await import('@/lib/admin-auth');
    expect(await getIsAdmin()).toBe(false);
    expect(vi.mocked((await import('@/lib/db')).getUserById)).not.toHaveBeenCalled();
  });

  it('returns false for a session with no id or a non-numeric id, without touching the DB', async () => {
    const { getIsAdmin } = await import('@/lib/admin-auth');
    const { getUserById } = await import('@/lib/db');

    (await mockedAuth()).mockResolvedValue(sessionClaiming(undefined, ['admin']));
    expect(await getIsAdmin()).toBe(false);

    (await mockedAuth()).mockResolvedValue(sessionClaiming('7; DROP TABLE users', ['admin']));
    expect(await getIsAdmin()).toBe(false);

    (await mockedAuth()).mockResolvedValue(sessionClaiming('0', ['admin']));
    expect(await getIsAdmin()).toBe(false);

    expect(vi.mocked(getUserById)).not.toHaveBeenCalled();
  });
});

describe('resolveActorFromDb()', () => {
  it('returns the current row for a numeric-string id', async () => {
    vi.mocked((await import('@/lib/db')).getUserById).mockReturnValue(row(['upload']));

    const { resolveActorFromDb } = await import('@/lib/admin-auth');
    const actor = await resolveActorFromDb('7');

    expect(actor?.permissions).toEqual(['upload']);
  });

  it('returns null for an absent, malformed or non-positive id', async () => {
    const { resolveActorFromDb } = await import('@/lib/admin-auth');

    expect(await resolveActorFromDb(undefined)).toBeNull();
    expect(await resolveActorFromDb('')).toBeNull();
    expect(await resolveActorFromDb('1.5')).toBeNull();
    expect(await resolveActorFromDb('-3')).toBeNull();
    expect(await resolveActorFromDb({ id: 7 })).toBeNull();
    expect(vi.mocked((await import('@/lib/db')).getUserById)).not.toHaveBeenCalled();
  });
});

describe('getCurrentActor()', () => {
  it('returns the DB row the session names, or null when it is gone', async () => {
    (await mockedAuth()).mockResolvedValue(sessionClaiming('7', ['admin']));
    vi.mocked((await import('@/lib/db')).getUserById).mockReturnValue(row(['upload']));

    const { getCurrentActor } = await import('@/lib/admin-auth');
    expect((await getCurrentActor())?.permissions).toEqual(['upload']);

    vi.mocked((await import('@/lib/db')).getUserById).mockReturnValue(undefined);
    expect(await getCurrentActor()).toBeNull();
  });
});
