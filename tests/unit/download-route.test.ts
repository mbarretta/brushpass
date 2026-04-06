/**
 * Route-handler unit tests for GET /api/download/[sha256]
 *
 * Focuses on the Content-Disposition header: verifies RFC 6266 dual-parameter
 * form for both plain ASCII filenames and filenames containing spaces.
 *
 * Kept in a separate file from download.test.ts so that vi.mock hoisting
 * here does not interfere with the real-DB tests in that file.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'stream';

// ---------------------------------------------------------------------------
// Module mocks — hoisted by Vitest before any imports
// ---------------------------------------------------------------------------

vi.mock('@/lib/token', () => ({
  verifyToken: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/gcs', () => ({
  getGCSReadStream: vi.fn().mockReturnValue(Readable.from([''])),
}));

vi.mock('@/lib/db', () => ({
  getFileBySha256: vi.fn(),
  logDownload: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A valid 64-char hex sha256 value for tests
const VALID_SHA256 = 'd8e8fca2dc0f896fd7cb4cb0031ba249d8e8fca2dc0f896fd7cb4cb0031ba249';

function makeRecord(original_name: string) {
  return {
    id: 1,
    filename: `${VALID_SHA256}.pdf`,
    original_name,
    sha256: VALID_SHA256,
    size: 4,
    content_type: 'application/pdf',
    gcs_key: `${VALID_SHA256}.pdf`,
    token_hash: '$2b$10$fakehash',
    expires_at: null,
    uploaded_by: null,
    created_at: Math.floor(Date.now() / 1000),
    uploaded_at: Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/download/[sha256] route handler — hex guard', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.mocked((await import('@/lib/token')).verifyToken).mockResolvedValue(true);
    vi.mocked((await import('@/lib/gcs')).getGCSReadStream).mockReturnValue(Readable.from(['']));
  });

  it('returns 404 with validation phase for a non-hex sha256', async () => {
    const { GET } = await import('@/app/api/download/[sha256]/route');
    const req = new Request('http://localhost/api/download/notahash?token=valid');
    const res = await GET(req as never, { params: Promise.resolve({ sha256: 'notahash' }) });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found', phase: 'validation' });
    expect(vi.mocked((await import('@/lib/db')).getFileBySha256)).not.toHaveBeenCalled();
  });

  it('returns 404 for a 63-char hex string (wrong length)', async () => {
    const shortHex = 'a'.repeat(63); // 63 chars — one short of valid SHA-256
    const { GET } = await import('@/app/api/download/[sha256]/route');
    const req = new Request(`http://localhost/api/download/${shortHex}?token=valid`);
    const res = await GET(req as never, { params: Promise.resolve({ sha256: shortHex }) });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found', phase: 'validation' });
    expect(vi.mocked((await import('@/lib/db')).getFileBySha256)).not.toHaveBeenCalled();
  });
});

describe('GET /api/download/[sha256] route handler — Content-Disposition', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    // Re-apply default implementations after reset
    vi.mocked((await import('@/lib/token')).verifyToken).mockResolvedValue(true);
    vi.mocked((await import('@/lib/gcs')).getGCSReadStream).mockReturnValue(Readable.from(['']));
  });

  it('emits RFC 6266 dual-parameter header for plain ASCII filename', async () => {
    vi.mocked((await import('@/lib/db')).getFileBySha256).mockReturnValue(
      makeRecord('report.pdf'),
    );

    const { GET } = await import('@/app/api/download/[sha256]/route');
    const req = new Request(`http://localhost/api/download/${VALID_SHA256}?token=valid`);
    const res = await GET(req as never, { params: Promise.resolve({ sha256: VALID_SHA256 }) });

    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it('percent-encodes spaces in dual-parameter header', async () => {
    vi.mocked((await import('@/lib/db')).getFileBySha256).mockReturnValue(
      makeRecord('my report 2026.pdf'),
    );

    const { GET } = await import('@/app/api/download/[sha256]/route');
    const req = new Request(`http://localhost/api/download/${VALID_SHA256}?token=valid`);
    const res = await GET(req as never, { params: Promise.resolve({ sha256: VALID_SHA256 }) });

    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename="my%20report%202026.pdf"; filename*=UTF-8''my%20report%202026.pdf`,
    );
  });
});
