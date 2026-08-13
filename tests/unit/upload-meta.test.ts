/**
 * Unit tests for the shared upload metadata helpers in src/lib/upload-meta.ts.
 *
 * deriveGcsKey and validateUploadMeta are pure functions with no external
 * dependencies (beyond src/lib/sha256.ts, itself pure), so these tests need
 * no mocking.
 */
import { describe, it, expect } from 'vitest';
import { deriveGcsKey, validateUploadMeta } from '@/lib/upload-meta';

const VALID_SHA256 = 'd8e8fca2dc0f896fd7cb4cb0031ba249d8e8fca2dc0f896fd7cb4cb0031ba249';

describe('deriveGcsKey', () => {
  it('derives <sha256>.<ext> from a normal filename', () => {
    expect(deriveGcsKey(VALID_SHA256, 'document.pdf')).toBe(`${VALID_SHA256}.pdf`);
  });

  it('lowercases the extension', () => {
    expect(deriveGcsKey(VALID_SHA256, 'IMAGE.PNG')).toBe(`${VALID_SHA256}.png`);
  });

  it('falls back to .bin when the filename has no extension', () => {
    expect(deriveGcsKey(VALID_SHA256, 'README')).toBe(`${VALID_SHA256}.bin`);
  });

  it('falls back to .bin for a dotfile with no real extension', () => {
    expect(deriveGcsKey(VALID_SHA256, '.gitignore')).toBe(`${VALID_SHA256}.bin`);
  });

  it('never contains a path separator or a ".." segment, even for a traversal filename', () => {
    const key = deriveGcsKey(VALID_SHA256, '../../etc/passwd');
    expect(key).not.toContain('/');
    expect(key).not.toContain('..');
    expect(key).toBe(`${VALID_SHA256}.bin`);
  });

  it('falls back to .bin when the extension exceeds the 8-char alphanumeric gate', () => {
    // A crafted "extension" that is itself an attempted path/host injection.
    expect(deriveGcsKey(VALID_SHA256, 'file.toolongext')).toBe(`${VALID_SHA256}.bin`);
  });

  it('falls back to .bin when the extension contains characters outside [a-z0-9]', () => {
    expect(deriveGcsKey(VALID_SHA256, 'file.p-f')).toBe(`${VALID_SHA256}.bin`);
    expect(deriveGcsKey(VALID_SHA256, 'file.p f')).toBe(`${VALID_SHA256}.bin`);
  });

  it('is a pure function of its two inputs — same sha256 and filename always derive the same key', () => {
    const a = deriveGcsKey(VALID_SHA256, 'report.docx');
    const b = deriveGcsKey(VALID_SHA256, 'report.docx');
    expect(a).toBe(b);
  });
});

describe('validateUploadMeta', () => {
  const validInput = {
    sha256: VALID_SHA256,
    filename: 'document.pdf',
    contentType: 'application/pdf',
    size: 1024,
  };

  it('accepts a fully valid input and normalizes the sha256 to lowercase', () => {
    const result = validateUploadMeta({ ...validInput, sha256: VALID_SHA256.toUpperCase() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.sha256).toBe(VALID_SHA256);
    }
  });

  it('rejects a sha256 that is not 64 hex characters', () => {
    const result = validateUploadMeta({ ...validInput, sha256: 'not-a-hash' });
    expect(result).toEqual({ ok: false, error: 'Invalid sha256' });
  });

  it('rejects a missing sha256', () => {
    const result = validateUploadMeta({ ...validInput, sha256: undefined });
    expect(result).toEqual({ ok: false, error: 'Invalid sha256' });
  });

  it('rejects a missing filename', () => {
    const result = validateUploadMeta({ ...validInput, filename: undefined });
    expect(result).toEqual({ ok: false, error: 'Missing required fields' });
  });

  it('rejects a missing contentType', () => {
    const result = validateUploadMeta({ ...validInput, contentType: undefined });
    expect(result).toEqual({ ok: false, error: 'Missing required fields' });
  });

  it('rejects a missing size', () => {
    const result = validateUploadMeta({ ...validInput, size: undefined });
    expect(result).toEqual({ ok: false, error: 'Missing required fields' });
  });

  it('rejects a zero or negative size', () => {
    expect(validateUploadMeta({ ...validInput, size: 0 })).toEqual({ ok: false, error: 'Invalid file size' });
    expect(validateUploadMeta({ ...validInput, size: -1 })).toEqual({ ok: false, error: 'Invalid file size' });
  });

  it('rejects a size over the 10 GB cap', () => {
    const result = validateUploadMeta({ ...validInput, size: 10 * 1024 * 1024 * 1024 + 1 });
    expect(result).toEqual({ ok: false, error: 'Invalid file size' });
  });

  it('rejects a non-numeric size', () => {
    const result = validateUploadMeta({ ...validInput, size: '1024' });
    expect(result).toEqual({ ok: false, error: 'Invalid file size' });
  });

  it('accepts ordinary content types', () => {
    for (const ct of ['application/pdf', 'image/png', 'application/octet-stream', 'text/plain']) {
      const result = validateUploadMeta({ ...validInput, contentType: ct });
      expect(result.ok).toBe(true);
    }
  });

  it('rejects a header-injection payload disguised as a content type (both prepare and complete use this)', () => {
    const result = validateUploadMeta({
      ...validInput,
      contentType: 'text/plain\r\nX-Injected: 1',
    });
    expect(result).toEqual({ ok: false, error: 'Invalid content type' });
  });

  it('rejects a content type that is only a valid prefix followed by garbage', () => {
    const result = validateUploadMeta({ ...validInput, contentType: 'application/pdf; extra stuff here' });
    expect(result.ok).toBe(false);
  });

  it('rejects an overlong content type', () => {
    const result = validateUploadMeta({
      ...validInput,
      contentType: `application/${'a'.repeat(300)}`,
    });
    expect(result).toEqual({ ok: false, error: 'Invalid content type' });
  });

  it('rejects a content type with no slash', () => {
    const result = validateUploadMeta({ ...validInput, contentType: 'notacontenttype' });
    expect(result).toEqual({ ok: false, error: 'Invalid content type' });
  });
});
