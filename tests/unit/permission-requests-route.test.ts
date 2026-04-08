/**
 * Unit tests for POST /api/permission-requests
 *
 * Tests the route handler in isolation with all external dependencies
 * mocked (auth, db).  Covers 401, 400 (empty), 400 (invalid), 201 (success),
 * and 200 alreadyPending (duplicate) cases.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — hoisted by Vitest before any imports
// ---------------------------------------------------------------------------

vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
  createPermissionRequest: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(id = '7') {
  return { user: { id, name: 'Test', permissions: [] } };
}

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/permission-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Returns a getDb mock where prepare().get() resolves to `existing`. */
function mockDb(existing: unknown = null) {
  return {
    prepare: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(existing) }),
  };
}

// ---------------------------------------------------------------------------
// Tests: POST /api/permission-requests
// ---------------------------------------------------------------------------

describe('POST /api/permission-requests', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when there is no session', async () => {
    const { auth } = await import('@/auth');
    vi.mocked(auth).mockResolvedValue(null as any);

    const { POST } = await import('@/app/api/permission-requests/route');
    const res = await POST(makeRequest({ permissions: ['upload'] }) as any);

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toEqual({ error: 'Unauthorized' });
  });

  it('returns 201 with { ok: true } for a valid new request', async () => {
    const { auth } = await import('@/auth');
    vi.mocked(auth).mockResolvedValue(makeSession('7') as any);

    const { getDb, createPermissionRequest } = await import('@/lib/db');
    vi.mocked(getDb).mockReturnValue(mockDb(null) as any);
    vi.mocked(createPermissionRequest).mockImplementation(() => undefined);

    const { POST } = await import('@/app/api/permission-requests/route');
    const res = await POST(makeRequest({ permissions: ['upload'] }) as any);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(vi.mocked(createPermissionRequest)).toHaveBeenCalledOnce();
  });

  it('returns 400 with { error: "Invalid permissions" } for an empty permissions array', async () => {
    const { auth } = await import('@/auth');
    vi.mocked(auth).mockResolvedValue(makeSession() as any);

    const { createPermissionRequest } = await import('@/lib/db');

    const { POST } = await import('@/app/api/permission-requests/route');
    const res = await POST(makeRequest({ permissions: [] }) as any);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: 'Invalid permissions' });
    expect(vi.mocked(createPermissionRequest)).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid permission value', async () => {
    const { auth } = await import('@/auth');
    vi.mocked(auth).mockResolvedValue(makeSession() as any);

    const { createPermissionRequest } = await import('@/lib/db');

    const { POST } = await import('@/app/api/permission-requests/route');
    const res = await POST(makeRequest({ permissions: ['superadmin'] }) as any);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toMatchObject({ error: expect.any(String) });
    expect(vi.mocked(createPermissionRequest)).not.toHaveBeenCalled();
  });

  it('returns 200 with { ok: true, alreadyPending: true } when a pending request already exists', async () => {
    const { auth } = await import('@/auth');
    vi.mocked(auth).mockResolvedValue(makeSession('7') as any);

    const { getDb, createPermissionRequest } = await import('@/lib/db');
    vi.mocked(getDb).mockReturnValue(mockDb({ id: 3 }) as any);

    const { POST } = await import('@/app/api/permission-requests/route');
    const res = await POST(makeRequest({ permissions: ['upload'] }) as any);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, alreadyPending: true });
    expect(vi.mocked(createPermissionRequest)).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid JSON body', async () => {
    const { auth } = await import('@/auth');
    vi.mocked(auth).mockResolvedValue(makeSession() as any);

    // Raw non-JSON body with Content-Type: application/json triggers req.json() parse failure
    const req = new Request('http://localhost/api/permission-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });

    const { POST } = await import('@/app/api/permission-requests/route');
    const res = await POST(req as any);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/invalid json/i);
  });
});
