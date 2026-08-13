/**
 * Unit tests for admin group API routes.
 * Mocks db, admin-auth, gcs, auth, crypto, and token helpers.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock('@/lib/admin-auth', () => ({ getIsAdmin: vi.fn() }));
vi.mock('@/auth', () => ({ auth: vi.fn().mockResolvedValue({ user: { name: 'admin' } }) }));
vi.mock('@/lib/token', () => ({ hashPassword: vi.fn().mockResolvedValue('$2b$10$hashed') }));
vi.mock('@/lib/gcs', () => ({
  generateSignedDownloadUrl: vi.fn(),
  deleteFromGCS: vi.fn(),
}));
// Don't mock crypto — randomBytes is pure and safe to run in tests.
vi.mock('@/lib/db', () => ({
  listGroups: vi.fn(),
  insertGroup: vi.fn(),
  getGroupBySlug: vi.fn(),
  listGroupFiles: vi.fn(),
  updateGroup: vi.fn(),
  deleteGroup: vi.fn(),
  getFileById: vi.fn(),
  addFileToGroup: vi.fn(),
  removeFileFromGroup: vi.fn(),
  isValidSlug: vi.fn(),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { getIsAdmin } from '@/lib/admin-auth';
import * as db from '@/lib/db';

// Mirrors the real safe-projection shape (no token_hash) returned by
// getGroupBySlug()/listGroups() — those are the only functions the admin
// group routes call.
const FAKE_GROUP = {
  id: 1,
  name: 'Test Group',
  slug: 'test-group',
  expires_at: null,
  created_by: 'admin',
  created_at: 1000000,
};

// insertGroup() is deliberately NOT a safe projection (its only caller already
// holds the plaintext token in the same response), so its mock return value
// still needs token_hash to satisfy the real function's type.
const FAKE_GROUP_WITH_HASH = { ...FAKE_GROUP, token_hash: '$2b$10$hashed' };

// Mirrors the real safe-projection shape (no token_hash) returned by listGroupFiles().
const FAKE_FILE = {
  id: 10,
  filename: 'abc.pdf',
  original_name: 'report.pdf',
  sha256: 'a'.repeat(64),
  size: 1024,
  content_type: 'application/pdf',
  gcs_key: 'abc.pdf',
  expires_at: null,
  uploaded_at: 1000000,
  uploaded_by: null,
};

function adminRequest(method: string, url: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getIsAdmin).mockResolvedValue(true);
  vi.mocked(db.isValidSlug).mockImplementation((s: string) => /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(s) && s.length <= 64);
});

// ── GET /api/admin/groups ────────────────────────────────────────────────────

describe('GET /api/admin/groups', () => {
  it('returns group list', async () => {
    vi.mocked(db.listGroups).mockReturnValue([{ ...FAKE_GROUP, member_count: 2 }]);
    const { GET } = await import('@/app/api/admin/groups/route');
    const res = await GET(adminRequest('GET', 'http://localhost/api/admin/groups') as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].slug).toBe('test-group');
    // No bcrypt hash in the response — listGroups() is a safe projection.
    expect(JSON.stringify(body)).not.toContain('$2b$');
  });

  it('returns 403 when not admin', async () => {
    vi.mocked(getIsAdmin).mockResolvedValue(false);
    const { GET } = await import('@/app/api/admin/groups/route');
    const res = await GET(adminRequest('GET', 'http://localhost/api/admin/groups') as never);
    expect(res.status).toBe(403);
  });
});

// ── POST /api/admin/groups ───────────────────────────────────────────────────

describe('POST /api/admin/groups', () => {
  it('creates a group and returns token once', async () => {
    vi.mocked(db.insertGroup).mockReturnValue(FAKE_GROUP_WITH_HASH);
    const { POST } = await import('@/app/api/admin/groups/route');
    const res = await POST(
      adminRequest('POST', 'http://localhost/api/admin/groups', { name: 'Test Group', slug: 'test-group' }) as never,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.slug).toBe('test-group');
    expect(body.token).toBeTypeOf('string');
    expect(body.token).toHaveLength(64); // 32 random bytes as hex
  });

  it('returns 400 for missing name', async () => {
    const { POST } = await import('@/app/api/admin/groups/route');
    const res = await POST(
      adminRequest('POST', 'http://localhost/api/admin/groups', { slug: 'test-group' }) as never,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid slug', async () => {
    vi.mocked(db.isValidSlug).mockReturnValue(false);
    const { POST } = await import('@/app/api/admin/groups/route');
    const res = await POST(
      adminRequest('POST', 'http://localhost/api/admin/groups', { name: 'Test', slug: 'Bad Slug!' }) as never,
    );
    expect(res.status).toBe(400);
  });

  it('returns 409 on duplicate slug', async () => {
    vi.mocked(db.insertGroup).mockImplementation(() => { throw new Error('UNIQUE constraint failed: file_groups.slug'); });
    const { POST } = await import('@/app/api/admin/groups/route');
    const res = await POST(
      adminRequest('POST', 'http://localhost/api/admin/groups', { name: 'Test', slug: 'test-group' }) as never,
    );
    expect(res.status).toBe(409);
  });
});

// ── GET /api/admin/groups/[slug] ─────────────────────────────────────────────

describe('GET /api/admin/groups/[slug]', () => {
  it('returns group with files', async () => {
    vi.mocked(db.getGroupBySlug).mockReturnValue(FAKE_GROUP);
    vi.mocked(db.listGroupFiles).mockReturnValue([FAKE_FILE]);
    const { GET } = await import('@/app/api/admin/groups/[slug]/route');
    const res = await GET(
      adminRequest('GET', 'http://localhost/api/admin/groups/test-group') as never,
      { params: Promise.resolve({ slug: 'test-group' }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBe('test-group');
    expect(body.files).toHaveLength(1);
    // No bcrypt hash in the response — getGroupBySlug()/listGroupFiles() are safe projections.
    expect(JSON.stringify(body)).not.toContain('$2b$');
  });

  it('returns 404 for unknown slug', async () => {
    vi.mocked(db.getGroupBySlug).mockReturnValue(undefined);
    const { GET } = await import('@/app/api/admin/groups/[slug]/route');
    const res = await GET(
      adminRequest('GET', 'http://localhost/api/admin/groups/no-such') as never,
      { params: Promise.resolve({ slug: 'no-such' }) },
    );
    expect(res.status).toBe(404);
  });
});

// ── PATCH /api/admin/groups/[slug] ───────────────────────────────────────────

describe('PATCH /api/admin/groups/[slug]', () => {
  it('renames the group', async () => {
    vi.mocked(db.getGroupBySlug).mockReturnValue(FAKE_GROUP);
    const { PATCH } = await import('@/app/api/admin/groups/[slug]/route');
    const res = await PATCH(
      adminRequest('PATCH', 'http://localhost/api/admin/groups/test-group', { name: 'Renamed' }) as never,
      { params: Promise.resolve({ slug: 'test-group' }) },
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(db.updateGroup)).toHaveBeenCalledWith(FAKE_GROUP.id, { name: 'Renamed' });
  });

  it('returns 404 for unknown group', async () => {
    vi.mocked(db.getGroupBySlug).mockReturnValue(undefined);
    const { PATCH } = await import('@/app/api/admin/groups/[slug]/route');
    const res = await PATCH(
      adminRequest('PATCH', 'http://localhost/api/admin/groups/no-such', { name: 'X' }) as never,
      { params: Promise.resolve({ slug: 'no-such' }) },
    );
    expect(res.status).toBe(404);
  });

  it('returns 409 on slug collision', async () => {
    vi.mocked(db.getGroupBySlug).mockReturnValue(FAKE_GROUP);
    vi.mocked(db.updateGroup).mockImplementation(() => { throw new Error('UNIQUE constraint failed: file_groups.slug'); });
    const { PATCH } = await import('@/app/api/admin/groups/[slug]/route');
    const res = await PATCH(
      adminRequest('PATCH', 'http://localhost/api/admin/groups/test-group', { slug: 'existing-slug' }) as never,
      { params: Promise.resolve({ slug: 'test-group' }) },
    );
    expect(res.status).toBe(409);
  });
});

// ── DELETE /api/admin/groups/[slug] ──────────────────────────────────────────

describe('DELETE /api/admin/groups/[slug]', () => {
  it('deletes the group', async () => {
    vi.mocked(db.getGroupBySlug).mockReturnValue(FAKE_GROUP);
    const { DELETE } = await import('@/app/api/admin/groups/[slug]/route');
    const res = await DELETE(
      adminRequest('DELETE', 'http://localhost/api/admin/groups/test-group') as never,
      { params: Promise.resolve({ slug: 'test-group' }) },
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(db.deleteGroup)).toHaveBeenCalledWith(FAKE_GROUP.id);
  });

  it('returns 404 for unknown group', async () => {
    vi.mocked(db.getGroupBySlug).mockReturnValue(undefined);
    const { DELETE } = await import('@/app/api/admin/groups/[slug]/route');
    const res = await DELETE(
      adminRequest('DELETE', 'http://localhost/api/admin/groups/no-such') as never,
      { params: Promise.resolve({ slug: 'no-such' }) },
    );
    expect(res.status).toBe(404);
  });
});

// ── POST /api/admin/groups/[slug]/files ──────────────────────────────────────

describe('POST /api/admin/groups/[slug]/files', () => {
  it('adds a file to the group', async () => {
    vi.mocked(db.getGroupBySlug).mockReturnValue(FAKE_GROUP);
    vi.mocked(db.getFileById).mockReturnValue(FAKE_FILE);
    const { POST } = await import('@/app/api/admin/groups/[slug]/files/route');
    const res = await POST(
      adminRequest('POST', 'http://localhost/api/admin/groups/test-group/files', { fileId: 10 }) as never,
      { params: Promise.resolve({ slug: 'test-group' }) },
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(db.addFileToGroup)).toHaveBeenCalledWith(FAKE_GROUP.id, FAKE_FILE.id);
  });

  it('returns 404 when file not found', async () => {
    vi.mocked(db.getGroupBySlug).mockReturnValue(FAKE_GROUP);
    vi.mocked(db.getFileById).mockReturnValue(undefined);
    const { POST } = await import('@/app/api/admin/groups/[slug]/files/route');
    const res = await POST(
      adminRequest('POST', 'http://localhost/api/admin/groups/test-group/files', { fileId: 99 }) as never,
      { params: Promise.resolve({ slug: 'test-group' }) },
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when group not found', async () => {
    vi.mocked(db.getGroupBySlug).mockReturnValue(undefined);
    const { POST } = await import('@/app/api/admin/groups/[slug]/files/route');
    const res = await POST(
      adminRequest('POST', 'http://localhost/api/admin/groups/no-such/files', { fileId: 10 }) as never,
      { params: Promise.resolve({ slug: 'no-such' }) },
    );
    expect(res.status).toBe(404);
  });
});

// ── DELETE /api/admin/groups/[slug]/files ────────────────────────────────────

describe('DELETE /api/admin/groups/[slug]/files', () => {
  it('removes a file from the group', async () => {
    vi.mocked(db.getGroupBySlug).mockReturnValue(FAKE_GROUP);
    const { DELETE } = await import('@/app/api/admin/groups/[slug]/files/route');
    const res = await DELETE(
      adminRequest('DELETE', 'http://localhost/api/admin/groups/test-group/files', { fileId: 10 }) as never,
      { params: Promise.resolve({ slug: 'test-group' }) },
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(db.removeFileFromGroup)).toHaveBeenCalledWith(FAKE_GROUP.id, 10);
  });

  it('returns 404 when group not found', async () => {
    vi.mocked(db.getGroupBySlug).mockReturnValue(undefined);
    const { DELETE } = await import('@/app/api/admin/groups/[slug]/files/route');
    const res = await DELETE(
      adminRequest('DELETE', 'http://localhost/api/admin/groups/no-such/files', { fileId: 10 }) as never,
      { params: Promise.resolve({ slug: 'no-such' }) },
    );
    expect(res.status).toBe(404);
  });
});
