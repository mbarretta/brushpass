/**
 * Tests for the [sha256]/page.tsx input validation guard.
 *
 * The page calls notFound() for any path segment that isn't a 64-char hex string,
 * matching the guard already present in the /api/download/[sha256] route.
 *
 * notFound() in Next.js throws a special NEXT_NOT_FOUND error internally.
 * We verify the guard fires (throws) for invalid inputs and doesn't throw for valid ones.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock next/navigation so notFound() throws something catchable in tests
// ---------------------------------------------------------------------------

const notFoundSpy = vi.fn(() => { throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_NOT_FOUND' }); });

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  notFound: notFoundSpy,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_SHA256 = 'd8e8fca2dc0f896fd7cb4cb0031ba249d8e8fca2dc0f896fd7cb4cb0031ba249';

async function renderPage(sha256: string, token?: string) {
  const { default: DownloadPage } = await import('@/app/[sha256]/page');
  return DownloadPage({
    params: Promise.resolve({ sha256 }),
    searchParams: Promise.resolve({ token }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('[sha256]/page — input validation guard', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    notFoundSpy.mockImplementation(() => {
      throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_NOT_FOUND' });
    });
  });

  it('calls notFound() for a non-hex string', async () => {
    await expect(renderPage('notahash')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundSpy).toHaveBeenCalledOnce();
  });

  it('calls notFound() for a 63-char hex string (one short)', async () => {
    await expect(renderPage('a'.repeat(63))).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundSpy).toHaveBeenCalledOnce();
  });

  it('calls notFound() for a 65-char hex string (one over)', async () => {
    await expect(renderPage('a'.repeat(65))).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundSpy).toHaveBeenCalledOnce();
  });

  it('calls notFound() for a path traversal attempt', async () => {
    await expect(renderPage('../../../etc/passwd')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundSpy).toHaveBeenCalledOnce();
  });

  it('calls notFound() for an empty string', async () => {
    await expect(renderPage('')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundSpy).toHaveBeenCalledOnce();
  });

  it('does NOT call notFound() for a valid 64-char lowercase hex sha256', async () => {
    // Page will call redirect() because no token is in searchParams — that's fine.
    // We just need to confirm notFound() was not called.
    try {
      await renderPage(VALID_SHA256);
    } catch {
      // redirect() may throw NEXT_REDIRECT internally — that's expected and OK
    }
    expect(notFoundSpy).not.toHaveBeenCalled();
  });

  it('does NOT call notFound() for a valid uppercase hex sha256', async () => {
    const upper = VALID_SHA256.toUpperCase();
    try {
      await renderPage(upper);
    } catch {
      // redirect() throws NEXT_REDIRECT — expected
    }
    expect(notFoundSpy).not.toHaveBeenCalled();
  });
});
