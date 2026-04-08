/**
 * Unit tests for admin permission-request API routes:
 *   GET  /api/admin/permission-requests
 *   POST /api/admin/permission-requests/[id]/approve
 *   DELETE /api/admin/permission-requests/[id]  (deny)
 *
 * Follows the pattern from admin-bulk-delete.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — hoisted by Vitest before any imports
// ---------------------------------------------------------------------------

vi.mock('@/lib/admin-auth', () => ({
  getIsAdmin: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
  listPendingPermissionRequests: vi.fn(),
  approvePermissionRequest: vi.fn(),
  denyPermissionRequest: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a minimal better-sqlite3-shaped DB stub. */
function mockDb(row: unknown = null) {
  return {
    prepare: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(row) }),
  };
}

function makeGetRequest() {
  return new Request('http://localhost/api/admin/permission-requests', { method: 'GET' });
}

function makePostRequest(id: string | number) {
  return new Request(`http://localhost/api/admin/permission-requests/${id}/approve`, {
    method: 'POST',
  });
}

function makeDeleteRequest(id: string | number) {
  return new Request(`http://localhost/api/admin/permission-requests/${id}`, {
    method: 'DELETE',
  });
}

function makeParams(id: string | number) {
  return { params: Promise.resolve({ id: String(id) }) };
}

// ---------------------------------------------------------------------------
// GET /api/admin/permission-requests
// ---------------------------------------------------------------------------

describe('GET /api/admin/permission-requests', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 403 when not admin', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(false);

    const { GET } = await import('@/app/api/admin/permission-requests/route');
    const res = await GET(makeGetRequest() as never);

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('Forbidden');
  });

  it('returns 200 with empty array when no pending requests', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(true);
    vi.mocked((await import('@/lib/db')).listPendingPermissionRequests).mockReturnValue([]);

    const { GET } = await import('@/app/api/admin/permission-requests/route');
    const res = await GET(makeGetRequest() as never);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([]);
  });

  it('returns 200 with request array when pending requests exist', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(true);

    const fakeRequests = [
      {
        id: 1,
        user_id: 10,
        username: 'alice',
        email: 'alice@example.com',
        requested_permissions: ['upload'],
        requested_at: 1700000000,
      },
    ];
    vi.mocked((await import('@/lib/db')).listPendingPermissionRequests).mockReturnValue(
      fakeRequests as never,
    );

    const { GET } = await import('@/app/api/admin/permission-requests/route');
    const res = await GET(makeGetRequest() as never);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveLength(1);
    expect(json[0].username).toBe('alice');
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/permission-requests/[id]/approve
// ---------------------------------------------------------------------------

describe('POST /api/admin/permission-requests/[id]/approve', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 403 when not admin', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(false);

    const { POST } = await import('@/app/api/admin/permission-requests/[id]/approve/route');
    const res = await POST(makePostRequest(1) as never, makeParams(1) as never);

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('Forbidden');
  });

  it('returns 404 when request not found', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(true);
    vi.mocked((await import('@/lib/db')).getDb).mockReturnValue(mockDb(null) as never);

    const { POST } = await import('@/app/api/admin/permission-requests/[id]/approve/route');
    const res = await POST(makePostRequest(99) as never, makeParams(99) as never);

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toMatch(/not found/i);
  });

  it('returns 200 and calls approvePermissionRequest with parsed permissions', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(true);

    // DB returns a row with JSON-encoded permissions
    const dbRow = { requested_permissions: '["upload"]' };
    vi.mocked((await import('@/lib/db')).getDb).mockReturnValue(mockDb(dbRow) as never);

    const db = await import('@/lib/db');
    vi.mocked(db.approvePermissionRequest).mockReturnValue(undefined as never);

    const { POST } = await import('@/app/api/admin/permission-requests/[id]/approve/route');
    const res = await POST(makePostRequest(5) as never, makeParams(5) as never);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.message).toMatch(/sign out/i);

    expect(vi.mocked(db.approvePermissionRequest)).toHaveBeenCalledWith(5, ['upload']);
  });

  it('returns 400 for non-numeric id', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(true);

    const { POST } = await import('@/app/api/admin/permission-requests/[id]/approve/route');
    const res = await POST(makePostRequest('abc') as never, makeParams('abc') as never);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/invalid id/i);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/permission-requests/[id]  (deny)
// ---------------------------------------------------------------------------

describe('DELETE /api/admin/permission-requests/[id]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 403 when not admin', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(false);

    const { DELETE } = await import('@/app/api/admin/permission-requests/[id]/route');
    const res = await DELETE(makeDeleteRequest(1) as never, makeParams(1) as never);

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('Forbidden');
  });

  it('returns 404 when request not found', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(true);
    vi.mocked((await import('@/lib/db')).getDb).mockReturnValue(mockDb(null) as never);

    const { DELETE } = await import('@/app/api/admin/permission-requests/[id]/route');
    const res = await DELETE(makeDeleteRequest(99) as never, makeParams(99) as never);

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toMatch(/not found/i);
  });

  it('returns 200 and calls denyPermissionRequest when found', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(true);

    const dbRow = { id: 7 };
    vi.mocked((await import('@/lib/db')).getDb).mockReturnValue(mockDb(dbRow) as never);

    const db = await import('@/lib/db');
    vi.mocked(db.denyPermissionRequest).mockReturnValue(undefined as never);

    const { DELETE } = await import('@/app/api/admin/permission-requests/[id]/route');
    const res = await DELETE(makeDeleteRequest(7) as never, makeParams(7) as never);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    expect(vi.mocked(db.denyPermissionRequest)).toHaveBeenCalledWith(7);
  });

  it('returns 400 for non-numeric id', async () => {
    vi.mocked((await import('@/lib/admin-auth')).getIsAdmin).mockResolvedValue(true);

    const { DELETE } = await import('@/app/api/admin/permission-requests/[id]/route');
    const res = await DELETE(makeDeleteRequest('abc') as never, makeParams('abc') as never);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/invalid id/i);
  });
});
