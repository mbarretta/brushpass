/**
 * Route-handler unit tests for GET /api/download/[md5]
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
  getFileByMd5: vi.fn(),
  logDownload: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(original_name: string) {
  return {
    id: 1,
    filename: 'abc.pdf',
    original_name,
    md5: 'abc123',
    size: 4,
    content_type: 'application/pdf',
    gcs_key: 'abc123.pdf',
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

describe('GET /api/download/[md5] route handler — Content-Disposition', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    // Re-apply default implementations after reset
    vi.mocked((await import('@/lib/token')).verifyToken).mockResolvedValue(true);
    vi.mocked((await import('@/lib/gcs')).getGCSReadStream).mockReturnValue(Readable.from(['']));
  });

  it('emits RFC 6266 dual-parameter header for plain ASCII filename', async () => {
    vi.mocked((await import('@/lib/db')).getFileByMd5).mockReturnValue(
      makeRecord('report.pdf'),
    );

    const { GET } = await import('@/app/api/download/[md5]/route');
    const req = new Request('http://localhost/api/download/abc123?token=valid');
    const res = await GET(req as never, { params: Promise.resolve({ md5: 'abc123' }) });

    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it('percent-encodes spaces in dual-parameter header', async () => {
    vi.mocked((await import('@/lib/db')).getFileByMd5).mockReturnValue(
      makeRecord('my report 2026.pdf'),
    );

    const { GET } = await import('@/app/api/download/[md5]/route');
    const req = new Request('http://localhost/api/download/abc123?token=valid');
    const res = await GET(req as never, { params: Promise.resolve({ md5: 'abc123' }) });

    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename="my%20report%202026.pdf"; filename*=UTF-8''my%20report%202026.pdf`,
    );
  });
});
