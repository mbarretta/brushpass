/**
 * Unit tests for PATCH /api/account
 *
 * Covers: 401 (no session), 400 (SSO account), 400 (missing fields),
 * 400 (password too short), 401 (wrong current password), 200 (success).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));

vi.mock('@/lib/db', () => ({
  getUserById: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock('@/lib/token', () => ({
  verifyToken: vi.fn(),
  hashPassword: vi.fn(),
}));

import { auth } from '@/auth';
import { getUserById, updateUser } from '@/lib/db';
import { verifyToken, hashPassword } from '@/lib/token';
import { PATCH } from '@/app/api/account/route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(id = '5') {
  return { user: { id, name: 'tester', permissions: ['upload'] } };
}

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    username: 'tester',
    password_hash: '$2a$10$hashhash',
    auth_provider: 'credentials',
    email: null,
    permissions: ['upload'],
    created_at: 0,
    ...overrides,
  };
}

function makeRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/account', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (hashPassword as ReturnType<typeof vi.fn>).mockResolvedValue('$2a$10$newhash');
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PATCH /api/account', () => {
  it('returns 401 when no session', async () => {
    (auth as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await PATCH(makeRequest({ currentPassword: 'old', newPassword: 'newpass1' }) as never);
    expect(res.status).toBe(401);
  });

  it('returns 400 for SSO accounts', async () => {
    (auth as ReturnType<typeof vi.fn>).mockResolvedValue(makeSession());
    (getUserById as ReturnType<typeof vi.fn>).mockReturnValue(makeUser({ auth_provider: 'oidc', password_hash: null }));
    const res = await PATCH(makeRequest({ currentPassword: 'x', newPassword: 'newpass1' }) as never);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/SSO/);
  });

  it('returns 400 when currentPassword is missing', async () => {
    (auth as ReturnType<typeof vi.fn>).mockResolvedValue(makeSession());
    (getUserById as ReturnType<typeof vi.fn>).mockReturnValue(makeUser());
    const res = await PATCH(makeRequest({ newPassword: 'newpass1' }) as never);
    expect(res.status).toBe(400);
  });

  it('returns 400 when newPassword is missing', async () => {
    (auth as ReturnType<typeof vi.fn>).mockResolvedValue(makeSession());
    (getUserById as ReturnType<typeof vi.fn>).mockReturnValue(makeUser());
    const res = await PATCH(makeRequest({ currentPassword: 'oldpass' }) as never);
    expect(res.status).toBe(400);
  });

  it('returns 400 when newPassword is too short', async () => {
    (auth as ReturnType<typeof vi.fn>).mockResolvedValue(makeSession());
    (getUserById as ReturnType<typeof vi.fn>).mockReturnValue(makeUser());
    (verifyToken as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const res = await PATCH(makeRequest({ currentPassword: 'oldpass', newPassword: 'short' }) as never);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/8 characters/);
  });

  it('returns 401 when current password is incorrect', async () => {
    (auth as ReturnType<typeof vi.fn>).mockResolvedValue(makeSession());
    (getUserById as ReturnType<typeof vi.fn>).mockReturnValue(makeUser());
    (verifyToken as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const res = await PATCH(makeRequest({ currentPassword: 'wrongpass', newPassword: 'newpass123' }) as never);
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/incorrect/);
  });

  it('returns 200 and calls updateUser on success', async () => {
    (auth as ReturnType<typeof vi.fn>).mockResolvedValue(makeSession());
    (getUserById as ReturnType<typeof vi.fn>).mockReturnValue(makeUser());
    (verifyToken as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const res = await PATCH(makeRequest({ currentPassword: 'oldpass', newPassword: 'newpass123' }) as never);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(updateUser).toHaveBeenCalledWith(5, { password_hash: '$2a$10$newhash' });
  });
});
