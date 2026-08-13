/**
 * Unit tests for POST /api/groups/[slug]/access — the anonymous group token
 * gate. Covers:
 *  - ac3: server-side bcrypt verification, manifest returned as
 *    PublicGroupFile objects only (no gcs_key, no token_hash).
 *  - ac4: an unknown slug and a wrong token are indistinguishable (same
 *    status, byte-identical body) and each performs exactly one bcrypt
 *    compare — neither an existence nor a timing oracle.
 *  - ac5: 410 only after the token verifies; expired member files excluded.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FileGroup, SafeFileRecord } from '@/types';

vi.mock('@/lib/db', () => ({
  getGroupBySlugForAuth: vi.fn(),
  listGroupFiles: vi.fn(),
  isValidSlug: vi.fn(),
}));

vi.mock('@/lib/token', () => ({
  verifyToken: vi.fn(),
}));

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/groups/test-group/access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeGroup(overrides: Partial<FileGroup> = {}): FileGroup {
  return {
    id: 1,
    name: 'Test Group',
    slug: 'test-group',
    token_hash: '$2b$10$realgrouphash000000000000000000000000000000000000000',
    expires_at: null,
    created_by: null,
    created_at: 1700000000,
    ...overrides,
  };
}

function makeFile(overrides: Partial<SafeFileRecord> = {}): SafeFileRecord {
  return {
    id: 1,
    filename: `${'a'.repeat(64)}.txt`,
    original_name: 'report.txt',
    sha256: 'a'.repeat(64),
    size: 100,
    content_type: 'text/plain',
    gcs_key: `${'a'.repeat(64)}.txt`,
    expires_at: null,
    uploaded_at: 1700000000,
    uploaded_by: null,
    ...overrides,
  };
}

describe('POST /api/groups/[slug]/access', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the manifest as PublicGroupFile objects only, on a valid token', async () => {
    const db = await import('@/lib/db');
    const token = await import('@/lib/token');
    vi.mocked(db.isValidSlug).mockReturnValue(true);
    vi.mocked(db.getGroupBySlugForAuth).mockReturnValue(makeGroup());
    vi.mocked(db.listGroupFiles).mockReturnValue([makeFile()]);
    vi.mocked(token.verifyToken).mockResolvedValue(true);

    const { POST } = await import('@/app/api/groups/[slug]/access/route');
    const res = await POST(makeRequest({ token: 'correct-token' }) as never, {
      params: Promise.resolve({ slug: 'test-group' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      name: 'Test Group',
      expires_at: null,
      files: [
        { sha256: 'a'.repeat(64), original_name: 'report.txt', size: 100, content_type: 'text/plain' },
      ],
    });
    expect(body.files[0]).not.toHaveProperty('gcs_key');
    expect(JSON.stringify(body)).not.toContain('$2b$');
    expect(token.verifyToken).toHaveBeenCalledTimes(1);
  });

  it('returns a byte-identical 401 for an unknown slug and a wrong token, each doing exactly one bcrypt compare', async () => {
    const db = await import('@/lib/db');
    const token = await import('@/lib/token');
    vi.mocked(db.isValidSlug).mockReturnValue(true);
    vi.mocked(token.verifyToken).mockResolvedValue(false);

    const { POST } = await import('@/app/api/groups/[slug]/access/route');

    // Unknown slug
    vi.mocked(db.getGroupBySlugForAuth).mockReturnValueOnce(undefined);
    const res1 = await POST(makeRequest({ token: 'whatever' }) as never, {
      params: Promise.resolve({ slug: 'unknown-slug' }),
    });
    const body1 = await res1.json();

    // Known slug, wrong token
    vi.mocked(db.getGroupBySlugForAuth).mockReturnValueOnce(makeGroup());
    const res2 = await POST(makeRequest({ token: 'wrong-token' }) as never, {
      params: Promise.resolve({ slug: 'test-group' }),
    });
    const body2 = await res2.json();

    expect(res1.status).toBe(401);
    expect(res2.status).toBe(401);
    expect(res1.status).toBe(res2.status);
    expect(body1).toEqual(body2);
    expect(token.verifyToken).toHaveBeenCalledTimes(2);
  });

  it('compares against a fixed dummy hash for an unknown slug instead of skipping the compare', async () => {
    const db = await import('@/lib/db');
    const token = await import('@/lib/token');
    vi.mocked(db.isValidSlug).mockReturnValue(true);
    vi.mocked(db.getGroupBySlugForAuth).mockReturnValue(undefined);
    vi.mocked(token.verifyToken).mockResolvedValue(false);

    const { POST } = await import('@/app/api/groups/[slug]/access/route');
    await POST(makeRequest({ token: 'anything' }) as never, {
      params: Promise.resolve({ slug: 'unknown-slug' }),
    });

    expect(token.verifyToken).toHaveBeenCalledTimes(1);
    const [, hashArg] = vi.mocked(token.verifyToken).mock.calls[0];
    expect(hashArg).toMatch(/^\$2[aby]\$\d{2}\$/);
  });

  it('rejects a slug that fails isValidSlug without a DB lookup, but still performs one compare', async () => {
    const db = await import('@/lib/db');
    const token = await import('@/lib/token');
    vi.mocked(db.isValidSlug).mockReturnValue(false);
    vi.mocked(token.verifyToken).mockResolvedValue(false);

    const { POST } = await import('@/app/api/groups/[slug]/access/route');
    const res = await POST(makeRequest({ token: 'whatever' }) as never, {
      params: Promise.resolve({ slug: '../../etc/passwd' }),
    });

    expect(res.status).toBe(401);
    expect(db.getGroupBySlugForAuth).not.toHaveBeenCalled();
    expect(token.verifyToken).toHaveBeenCalledTimes(1);
  });

  it('returns 410 only after the token verifies for an expired group', async () => {
    const db = await import('@/lib/db');
    const token = await import('@/lib/token');
    vi.mocked(db.isValidSlug).mockReturnValue(true);
    vi.mocked(db.getGroupBySlugForAuth).mockReturnValue(makeGroup({ expires_at: 1 }));
    vi.mocked(token.verifyToken).mockResolvedValue(true);

    const { POST } = await import('@/app/api/groups/[slug]/access/route');
    const res = await POST(makeRequest({ token: 'correct-token' }) as never, {
      params: Promise.resolve({ slug: 'test-group' }),
    });

    expect(res.status).toBe(410);
    expect(db.listGroupFiles).not.toHaveBeenCalled();
  });

  it('does not reveal expiry for an expired group when the token is wrong', async () => {
    const db = await import('@/lib/db');
    const token = await import('@/lib/token');
    vi.mocked(db.isValidSlug).mockReturnValue(true);
    vi.mocked(db.getGroupBySlugForAuth).mockReturnValue(makeGroup({ expires_at: 1 }));
    vi.mocked(token.verifyToken).mockResolvedValue(false);

    const { POST } = await import('@/app/api/groups/[slug]/access/route');
    const res = await POST(makeRequest({ token: 'wrong-token' }) as never, {
      params: Promise.resolve({ slug: 'test-group' }),
    });

    expect(res.status).toBe(401);
  });

  it('excludes member files whose own expires_at has passed', async () => {
    const db = await import('@/lib/db');
    const token = await import('@/lib/token');
    const now = Math.floor(Date.now() / 1000);
    vi.mocked(db.isValidSlug).mockReturnValue(true);
    vi.mocked(db.getGroupBySlugForAuth).mockReturnValue(makeGroup());
    vi.mocked(db.listGroupFiles).mockReturnValue([
      makeFile({ sha256: 'b'.repeat(64), expires_at: null }),
      makeFile({ sha256: 'c'.repeat(64), expires_at: now - 3600 }),
    ]);
    vi.mocked(token.verifyToken).mockResolvedValue(true);

    const { POST } = await import('@/app/api/groups/[slug]/access/route');
    const res = await POST(makeRequest({ token: 'correct-token' }) as never, {
      params: Promise.resolve({ slug: 'test-group' }),
    });
    const body = await res.json();

    expect(body.files).toHaveLength(1);
    expect(body.files[0].sha256).toBe('b'.repeat(64));
  });

  it('returns a generic 401 for a malformed request body instead of throwing a 500', async () => {
    const db = await import('@/lib/db');
    const token = await import('@/lib/token');
    vi.mocked(db.isValidSlug).mockReturnValue(true);
    vi.mocked(db.getGroupBySlugForAuth).mockReturnValue(makeGroup());
    vi.mocked(token.verifyToken).mockResolvedValue(false);

    const { POST } = await import('@/app/api/groups/[slug]/access/route');
    const req = new Request('http://localhost/api/groups/test-group/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    const res = await POST(req as never, { params: Promise.resolve({ slug: 'test-group' }) });

    expect(res.status).toBe(401);
  });
});
