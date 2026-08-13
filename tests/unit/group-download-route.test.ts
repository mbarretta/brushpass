/**
 * Unit tests for GET /api/groups/[slug]/files/[sha256] — the group member
 * file download route. Covers ac6: a member file's own expiry is enforced
 * independently of the group's expiry, after the token has verified.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FileGroup, SafeFileRecord } from '@/types';

vi.mock('@/lib/db', () => ({
  getGroupBySlugForAuth: vi.fn(),
  listGroupFiles: vi.fn(),
}));

vi.mock('@/lib/token', () => ({
  verifyToken: vi.fn(),
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
    vi.mocked(token.verifyToken).mockResolvedValue(true);

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
    vi.mocked(token.verifyToken).mockResolvedValue(true);
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
    vi.mocked(token.verifyToken).mockResolvedValue(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('file-bytes')));

    const { GET } = await import('@/app/api/groups/[slug]/files/[sha256]/route');
    const res = await GET(makeRequest('correct-token') as never, {
      params: Promise.resolve({ slug: 'test-group', sha256: SHA }),
    });

    expect(res.status).toBe(200);
  });
});
