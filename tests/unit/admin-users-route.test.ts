/**
 * Unit tests for the admin user-management routes:
 *   POST   /api/admin/users            (create)
 *   PATCH  /api/admin/users/[id]       (rename, permissions, password reset)
 *
 * Covers ac1 (shared 12/128-char password policy on admin create + reset)
 * and ac2 (IdP-bypass prevention: PATCH refuses a password field for a
 * non-'credentials' target user, mirroring /api/account's own check).
 *
 * @/lib/token is left unmocked deliberately — validatePassword/validateUsername
 * are pure and hashPassword's real bcrypt cost is negligible, so exercising the
 * real password policy here is more faithful than re-declaring its rules as a
 * mock. Only @/lib/db and @/lib/admin-auth are mocked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — hoisted by Vitest before any imports
// ---------------------------------------------------------------------------

vi.mock('@/lib/admin-auth', () => ({
  getIsAdmin: vi.fn(),
  // Faithful re-implementation (not vi.importActual) so this stays isolated
  // from the real module's @/auth import — matches VALID_PERMISSIONS = ['upload', 'admin'].
  isValidPermissionsArray: (value: unknown) =>
    Array.isArray(value) && value.every((p) => p === 'upload' || p === 'admin'),
}));

vi.mock('@/lib/db', () => ({
  listUsers: vi.fn(),
  createUser: vi.fn(),
  getUserById: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: vi.fn() }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STRONG_PASSWORD = 'correct-horse-battery'; // 21 chars, clears the 12-char minimum

function makeCreateRequest(body: unknown): Request {
  return new Request('http://localhost/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makePatchRequest(body: unknown): Request {
  return new Request('http://localhost/api/admin/users/1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeParams(id: string | number) {
  return { params: Promise.resolve({ id: String(id) }) };
}

function makeSafeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    username: 'target',
    auth_provider: 'credentials',
    email: null,
    permissions: ['upload'],
    created_at: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// POST /api/admin/users (create)
// ---------------------------------------------------------------------------

describe('POST /api/admin/users', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 403 when not admin', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(false);

    const { POST } = await import('@/app/api/admin/users/route');
    const res = await POST(makeCreateRequest({
      username: 'newuser',
      password: STRONG_PASSWORD,
      permissions: ['upload'],
    }) as never);

    expect(res.status).toBe(403);
  });

  it('rejects a 1-character password (closes the admin-create gap)', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(true);
    const { createUser } = await import('@/lib/db');

    const { POST } = await import('@/app/api/admin/users/route');
    const res = await POST(makeCreateRequest({
      username: 'newuser',
      password: 'a',
      permissions: ['upload'],
    }) as never);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/12 characters/);
    expect(vi.mocked(createUser)).not.toHaveBeenCalled();
  });

  it('rejects a password just below the 12-character minimum', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(true);

    const { POST } = await import('@/app/api/admin/users/route');
    const res = await POST(makeCreateRequest({
      username: 'newuser',
      password: 'a'.repeat(11),
      permissions: ['upload'],
    }) as never);

    expect(res.status).toBe(400);
  });

  it('rejects an invalid username', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(true);
    const { createUser } = await import('@/lib/db');

    const { POST } = await import('@/app/api/admin/users/route');
    const res = await POST(makeCreateRequest({
      username: 'bad user\r\n',
      password: STRONG_PASSWORD,
      permissions: ['upload'],
    }) as never);

    expect(res.status).toBe(400);
    expect(vi.mocked(createUser)).not.toHaveBeenCalled();
  });

  it('rejects an invalid permissions value', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(true);
    const { createUser } = await import('@/lib/db');

    const { POST } = await import('@/app/api/admin/users/route');
    const res = await POST(makeCreateRequest({
      username: 'newuser',
      password: STRONG_PASSWORD,
      permissions: ['superadmin'],
    }) as never);

    expect(res.status).toBe(400);
    expect(vi.mocked(createUser)).not.toHaveBeenCalled();
  });

  it('creates the user when username, password and permissions are all valid', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(true);
    const { createUser } = await import('@/lib/db');
    vi.mocked(createUser).mockReturnValue(makeSafeUser({ username: 'newuser' }) as never);

    const { POST } = await import('@/app/api/admin/users/route');
    const res = await POST(makeCreateRequest({
      username: 'newuser',
      password: STRONG_PASSWORD,
      permissions: ['upload'],
    }) as never);

    expect(res.status).toBe(201);
    expect(vi.mocked(createUser)).toHaveBeenCalledOnce();
    const call = vi.mocked(createUser).mock.calls[0][0];
    expect(call.username).toBe('newuser');
    expect(call.password_hash).toMatch(/^\$2[aby]\$/);
    expect(call.permissions).toEqual(['upload']);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/users/[id]
// ---------------------------------------------------------------------------

describe('PATCH /api/admin/users/[id]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 403 when not admin', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(false);

    const { PATCH } = await import('@/app/api/admin/users/[id]/route');
    const res = await PATCH(makePatchRequest({ password: STRONG_PASSWORD }) as never, makeParams(1) as never);

    expect(res.status).toBe(403);
  });

  it('rejects a 1-character reset password (closes the admin-reset gap)', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(true);
    const { getUserById, updateUser } = await import('@/lib/db');
    vi.mocked(getUserById).mockReturnValue(makeSafeUser() as never);

    const { PATCH } = await import('@/app/api/admin/users/[id]/route');
    const res = await PATCH(makePatchRequest({ password: 'x' }) as never, makeParams(1) as never);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/12 characters/);
    expect(vi.mocked(updateUser)).not.toHaveBeenCalled();
  });

  it('refuses a password field for a non-credentials (SSO) target user — IdP-bypass prevention', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(true);
    const { getUserById, updateUser } = await import('@/lib/db');
    vi.mocked(getUserById).mockReturnValue(makeSafeUser({ auth_provider: 'oidc' }) as never);

    const { PATCH } = await import('@/app/api/admin/users/[id]/route');
    const res = await PATCH(makePatchRequest({ password: STRONG_PASSWORD }) as never, makeParams(1) as never);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/SSO/);
    expect(vi.mocked(updateUser)).not.toHaveBeenCalled();
  });

  it('returns 404 when the target user does not exist and a password field is present', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(true);
    const { getUserById } = await import('@/lib/db');
    vi.mocked(getUserById).mockReturnValue(undefined);

    const { PATCH } = await import('@/app/api/admin/users/[id]/route');
    const res = await PATCH(makePatchRequest({ password: STRONG_PASSWORD }) as never, makeParams(999) as never);

    expect(res.status).toBe(404);
  });

  it('resets the password when the target user is a credentials account and the password is valid', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(true);
    const { getUserById, updateUser } = await import('@/lib/db');
    vi.mocked(getUserById).mockReturnValue(makeSafeUser({ auth_provider: 'credentials' }) as never);

    const { PATCH } = await import('@/app/api/admin/users/[id]/route');
    const res = await PATCH(makePatchRequest({ password: STRONG_PASSWORD }) as never, makeParams(1) as never);

    expect(res.status).toBe(200);
    expect(vi.mocked(updateUser)).toHaveBeenCalledOnce();
    const [id, patch] = vi.mocked(updateUser).mock.calls[0];
    expect(id).toBe(1);
    expect(patch.password_hash).toMatch(/^\$2[aby]\$/);
  });

  it('rejects an invalid username on rename', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(true);
    const { updateUser } = await import('@/lib/db');

    const { PATCH } = await import('@/app/api/admin/users/[id]/route');
    const res = await PATCH(makePatchRequest({ username: 'bad name' }) as never, makeParams(1) as never);

    expect(res.status).toBe(400);
    expect(vi.mocked(updateUser)).not.toHaveBeenCalled();
  });

  it('rejects an invalid permissions value', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(true);
    const { updateUser } = await import('@/lib/db');

    const { PATCH } = await import('@/app/api/admin/users/[id]/route');
    const res = await PATCH(makePatchRequest({ permissions: ['root'] }) as never, makeParams(1) as never);

    expect(res.status).toBe(400);
    expect(vi.mocked(updateUser)).not.toHaveBeenCalled();
  });

  it('updates permissions for a valid permissions array', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(true);
    const { updateUser } = await import('@/lib/db');

    const { PATCH } = await import('@/app/api/admin/users/[id]/route');
    const res = await PATCH(makePatchRequest({ permissions: ['upload', 'admin'] }) as never, makeParams(1) as never);

    expect(res.status).toBe(200);
    expect(vi.mocked(updateUser)).toHaveBeenCalledWith(1, { permissions: ['upload', 'admin'] });
  });
});
