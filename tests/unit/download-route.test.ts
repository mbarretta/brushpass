/**
 * Route-handler unit tests for GET /api/download/[sha256]
 *
 * Since the route now redirects to a signed GCS URL (bypassing the Cloud Run
 * 32MB response size limit), tests verify:
 *   - hex guard (404 for invalid sha256)
 *   - 302 redirect to a signed URL that encodes the correct Content-Disposition
 *     parameters in responseDisposition
 *
 * Kept in a separate file from download.test.ts so that vi.mock hoisting
 * here does not interfere with the real-DB tests in that file.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — hoisted by Vitest before any imports
// ---------------------------------------------------------------------------

vi.mock('@/lib/token', () => ({
  verifyToken: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/gcs', () => ({
  generateSignedDownloadUrl: vi.fn(),
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
    vi.mocked((await import('@/lib/gcs')).generateSignedDownloadUrl).mockResolvedValue(
      'https://storage.googleapis.com/signed',
    );
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
    const shortHex = 'a'.repeat(63);
    const { GET } = await import('@/app/api/download/[sha256]/route');
    const req = new Request(`http://localhost/api/download/${shortHex}?token=valid`);
    const res = await GET(req as never, { params: Promise.resolve({ sha256: shortHex }) });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found', phase: 'validation' });
    expect(vi.mocked((await import('@/lib/db')).getFileBySha256)).not.toHaveBeenCalled();
  });
});

describe('GET /api/download/[sha256] route handler — signed redirect', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.mocked((await import('@/lib/token')).verifyToken).mockResolvedValue(true);
    vi.mocked((await import('@/lib/gcs')).generateSignedDownloadUrl).mockResolvedValue(
      'https://storage.googleapis.com/signed',
    );
  });

  it('returns 302 redirect to signed GCS URL', async () => {
    vi.mocked((await import('@/lib/db')).getFileBySha256).mockReturnValue(
      makeRecord('report.pdf'),
    );

    const { GET } = await import('@/app/api/download/[sha256]/route');
    const req = new Request(`http://localhost/api/download/${VALID_SHA256}?token=valid`);
    const res = await GET(req as never, { params: Promise.resolve({ sha256: VALID_SHA256 }) });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://storage.googleapis.com/signed');
  });

  it('passes correct originalName and contentType to generateSignedDownloadUrl', async () => {
    vi.mocked((await import('@/lib/db')).getFileBySha256).mockReturnValue(
      makeRecord('my report 2026.pdf'),
    );

    const { GET } = await import('@/app/api/download/[sha256]/route');
    const req = new Request(`http://localhost/api/download/${VALID_SHA256}?token=valid`);
    await GET(req as never, { params: Promise.resolve({ sha256: VALID_SHA256 }) });

    const gcs = await import('@/lib/gcs');
    expect(vi.mocked(gcs.generateSignedDownloadUrl)).toHaveBeenCalledWith(
      `${VALID_SHA256}.pdf`,
      'my report 2026.pdf',
      'application/pdf',
    );
  });
});
