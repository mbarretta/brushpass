/**
 * Unit tests for GET /api/groups/[slug]/files/[sha256] — the group member
 * file download route. Covers:
 *  - a member file's own expiry, enforced independently of the group's, after
 *    the token has verified;
 *  - the pre-verify existence/expiry oracle being closed: an unknown group and
 *    a wrong token produce byte-identical 401s, and the 410 for an expired
 *    group is reachable only once a valid token has been presented.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FileGroup, SafeFileRecord } from '@/types';

vi.mock('@/lib/db', () => ({
  getGroupBySlugForAuth: vi.fn(),
  listGroupFiles: vi.fn(),
  isValidSlug: vi.fn(),
}));

vi.mock('@/lib/token', () => ({
  verifySecret: vi.fn(),
}));

vi.mock('@/lib/sha256', () => ({
  isValidSha256: vi.fn((s: string) => /^[a-f0-9]{64}$/i.test(s)),
}));

vi.mock('@/lib/gcs', () => ({
  generateSignedDownloadUrl: vi.fn(),
}));

const SHA = 'a'.repeat(64);

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
    filename: `${SHA}.txt`,
    original_name: 'report.txt',
    sha256: SHA,
    size: 100,
    content_type: 'text/plain',
    gcs_key: `${SHA}.txt`,
    expires_at: null,
    uploaded_at: 1700000000,
    uploaded_by: null,
    ...overrides,
  };
}

function makeRequest(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`http://localhost/api/groups/test-group/files/${SHA}`, { headers });
}

describe('GET /api/groups/[slug]/files/[sha256]', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    const gcs = await import('@/lib/gcs');
    vi.mocked(gcs.generateSignedDownloadUrl).mockResolvedValue('https://storage.googleapis.com/signed');
    // The route only looks a group up for a syntactically valid slug; default to
    // valid so each case drives the branch it is actually about.
    const db = await import('@/lib/db');
    vi.mocked(db.isValidSlug).mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns 410 when the member file has its own expiry in the past, even though the group has none', async () => {
    const db = await import('@/lib/db');
    const token = await import('@/lib/token');
    vi.mocked(db.getGroupBySlugForAuth).mockReturnValue(makeGroup({ expires_at: null }));
    vi.mocked(db.listGroupFiles).mockReturnValue([
      makeFile({ expires_at: Math.floor(Date.now() / 1000) - 3600 }),
    ]);
    vi.mocked(token.verifySecret).mockResolvedValue(true);

    const { GET } = await import('@/app/api/groups/[slug]/files/[sha256]/route');
    const res = await GET(makeRequest('correct-token') as never, {
      params: Promise.resolve({ slug: 'test-group', sha256: SHA }),
    });

    expect(res.status).toBe(410);
  });

  it('serves the file when its own expiry is in the future', async () => {
    const db = await import('@/lib/db');
    const token = await import('@/lib/token');
    vi.mocked(db.getGroupBySlugForAuth).mockReturnValue(makeGroup());
    vi.mocked(db.listGroupFiles).mockReturnValue([
      makeFile({ expires_at: Math.floor(Date.now() / 1000) + 3600 }),
    ]);
    vi.mocked(token.verifySecret).mockResolvedValue(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('file-bytes')));

    const { GET } = await import('@/app/api/groups/[slug]/files/[sha256]/route');
    const res = await GET(makeRequest('correct-token') as never, {
      params: Promise.resolve({ slug: 'test-group', sha256: SHA }),
    });

    expect(res.status).toBe(200);
  });

  it('serves the file when it has no expiry at all', async () => {
    const db = await import('@/lib/db');
    const token = await import('@/lib/token');
    vi.mocked(db.getGroupBySlugForAuth).mockReturnValue(makeGroup());
    vi.mocked(db.listGroupFiles).mockReturnValue([makeFile({ expires_at: null })]);
    vi.mocked(token.verifySecret).mockResolvedValue(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('file-bytes')));

    const { GET } = await import('@/app/api/groups/[slug]/files/[sha256]/route');
    const res = await GET(makeRequest('correct-token') as never, {
      params: Promise.resolve({ slug: 'test-group', sha256: SHA }),
    });

    expect(res.status).toBe(200);
  });

  it('returns a byte-identical 401 for an unknown group and for a wrong token, each doing exactly one compare', async () => {
    const db = await import('@/lib/db');
    const token = await import('@/lib/token');
    vi.mocked(token.verifySecret).mockResolvedValue(false);

    const { GET } = await import('@/app/api/groups/[slug]/files/[sha256]/route');

    // Unknown group
    vi.mocked(db.getGroupBySlugForAuth).mockReturnValueOnce(undefined);
    const res1 = await GET(makeRequest('whatever') as never, {
      params: Promise.resolve({ slug: 'unknown-group', sha256: SHA }),
    });
    const body1 = await res1.json();

    // Known group, wrong token
    vi.mocked(db.getGroupBySlugForAuth).mockReturnValueOnce(makeGroup());
    const res2 = await GET(makeRequest('wrong-token') as never, {
      params: Promise.resolve({ slug: 'test-group', sha256: SHA }),
    });
    const body2 = await res2.json();

    expect(res1.status).toBe(401);
    expect(res2.status).toBe(401);
    expect(body1).toEqual(body2);
    // One compare per request, and the absent hash arrives as null.
    expect(token.verifySecret).toHaveBeenCalledTimes(2);
    expect(vi.mocked(token.verifySecret).mock.calls[0][1]).toBeNull();
    // No file rows are read for a caller who has not proven token possession.
    expect(db.listGroupFiles).not.toHaveBeenCalled();
  });

  it('does not reveal an expired group to a caller with a wrong token (401, not 410)', async () => {
    const db = await import('@/lib/db');
    const token = await import('@/lib/token');
    vi.mocked(db.getGroupBySlugForAuth).mockReturnValue(makeGroup({ expires_at: 1 }));
    vi.mocked(token.verifySecret).mockResolvedValue(false);

    const { GET } = await import('@/app/api/groups/[slug]/files/[sha256]/route');
    const res = await GET(makeRequest('wrong-token') as never, {
      params: Promise.resolve({ slug: 'test-group', sha256: SHA }),
    });

    expect(res.status).toBe(401);
  });

  it('returns 410 for an expired group only once the token verifies', async () => {
    const db = await import('@/lib/db');
    const token = await import('@/lib/token');
    vi.mocked(db.getGroupBySlugForAuth).mockReturnValue(makeGroup({ expires_at: 1 }));
    vi.mocked(token.verifySecret).mockResolvedValue(true);

    const { GET } = await import('@/app/api/groups/[slug]/files/[sha256]/route');
    const res = await GET(makeRequest('correct-token') as never, {
      params: Promise.resolve({ slug: 'test-group', sha256: SHA }),
    });

    expect(res.status).toBe(410);
  });

  it('rejects a slug that fails isValidSlug without a DB lookup, but still performs one compare', async () => {
    const db = await import('@/lib/db');
    const token = await import('@/lib/token');
    vi.mocked(db.isValidSlug).mockReturnValue(false);
    vi.mocked(token.verifySecret).mockResolvedValue(false);

    const { GET } = await import('@/app/api/groups/[slug]/files/[sha256]/route');
    const res = await GET(makeRequest('whatever') as never, {
      params: Promise.resolve({ slug: '../../etc/passwd', sha256: SHA }),
    });

    expect(res.status).toBe(401);
    expect(db.getGroupBySlugForAuth).not.toHaveBeenCalled();
    expect(token.verifySecret).toHaveBeenCalledTimes(1);
  });
});
