import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be at the top of the file (vi.mock is hoisted)
// ---------------------------------------------------------------------------

vi.mock('@/lib/db', () => ({
  getFileById: vi.fn(),
  updateFileTokenHash: vi.fn(),
}));

vi.mock('@/lib/token', () => ({
  generateToken: vi.fn(),
  hashToken: vi.fn(),
}));

vi.mock('@/lib/admin-auth', () => ({
  getIsAdmin: vi.fn(),
}));

vi.mock('@/lib/gcs', () => ({
  deleteFromGCS: vi.fn(),
  streamToGCS: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mock declarations)
// ---------------------------------------------------------------------------

import { POST } from '@/app/api/admin/files/[id]/route';
import { getFileById, updateFileTokenHash } from '@/lib/db';
import { generateToken, hashToken } from '@/lib/token';
import { getIsAdmin } from '@/lib/admin-auth';
import type { FileRecord } from '@/types';

// ---------------------------------------------------------------------------
// Typed mock aliases
// ---------------------------------------------------------------------------

const mockGetIsAdmin = getIsAdmin as ReturnType<typeof vi.fn>;
const mockGetFileById = getFileById as ReturnType<typeof vi.fn>;
const mockUpdateFileTokenHash = updateFileTokenHash as ReturnType<typeof vi.fn>;
const mockGenerateToken = generateToken as ReturnType<typeof vi.fn>;
const mockHashToken = hashToken as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function makeRequest() {
  return new Request('http://localhost/api/admin/files/1', { method: 'POST' });
}

const SAMPLE_FILE: FileRecord = {
  id: 1,
  filename: 'file.txt',
  original_name: 'file.txt',
  md5: 'abc123',
  size: 100,
  content_type: 'text/plain',
  gcs_key: 'uploads/file.txt',
  token_hash: '$2b$oldhash',
  expires_at: null,
  uploaded_at: 1700000000,
  uploaded_by: 'admin',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/admin/files/[id] (token regeneration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 403 when not admin', async () => {
    mockGetIsAdmin.mockResolvedValue(false);
    const res = await POST(makeRequest() as never, makeParams('1'));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('returns 400 for non-numeric id', async () => {
    mockGetIsAdmin.mockResolvedValue(true);
    const res = await POST(makeRequest() as never, makeParams('abc'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid id');
  });

  it('returns 404 when file not found', async () => {
    mockGetIsAdmin.mockResolvedValue(true);
    mockGetFileById.mockReturnValue(undefined);
    const res = await POST(makeRequest() as never, makeParams('1'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('File not found');
  });

  it('returns 200 with token on success and calls updateFileTokenHash', async () => {
    mockGetIsAdmin.mockResolvedValue(true);
    mockGetFileById.mockReturnValue(SAMPLE_FILE);
    mockGenerateToken.mockReturnValue('abc123');
    mockHashToken.mockResolvedValue('$2b$hash');

    const res = await POST(makeRequest() as never, makeParams('1'));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.token).toBe('abc123');

    // hash must not be in the response
    expect(body.hash).toBeUndefined();

    // DB helper called with numeric id and the hashed token
    expect(mockUpdateFileTokenHash).toHaveBeenCalledWith(1, '$2b$hash');
    expect(mockUpdateFileTokenHash).toHaveBeenCalledTimes(1);
  });
});
