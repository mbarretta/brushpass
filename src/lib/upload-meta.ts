import path from 'path';
import { normalizeSha256 } from '@/lib/sha256';

/**
 * Object-key extensions are restricted to this charset (after lowercasing);
 * anything else — including no extension, a dotfile, or a traversal
 * attempt — falls back to 'bin'. This is what keeps deriveGcsKey's output
 * free of path separators and '..' regardless of the input filename.
 */
const EXT_PATTERN = /^[a-z0-9]{1,8}$/;

// End-anchored and length-capped so a header-injection payload like
// 'text/plain\r\nX-Injected: 1' cannot pass as a prefix match.
const CONTENT_TYPE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*$/;
const MAX_CONTENT_TYPE_LENGTH = 255;

export const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024; // 10 GB

/**
 * Derive the GCS object key from server-validated inputs only: the sha256
 * digest and the filename's extension. This is the single producer of
 * object keys for both the prepare and complete phases of an upload — the
 * key is never accepted from the client (see validateUploadMeta, which
 * deliberately has no gcsKey field). The extension is lowercased and gated
 * to a short alphanumeric charset (with a 'bin' fallback), so the result
 * can never contain a '/' or a '..' segment no matter what `filename` is.
 */
export function deriveGcsKey(sha256: string, filename: string): string {
  const rawExt = path.extname(filename).slice(1).toLowerCase();
  const ext = EXT_PATTERN.test(rawExt) ? rawExt : 'bin';
  return `${sha256}.${ext}`;
}

export interface UploadMetaInput {
  sha256?: unknown;
  filename?: unknown;
  contentType?: unknown;
  size?: unknown;
}

export interface ValidatedUploadMeta {
  sha256: string;
  filename: string;
  contentType: string;
  size: number;
}

export type UploadMetaValidation =
  | { ok: true; data: ValidatedUploadMeta }
  | { ok: false; error: string };

/**
 * Shared validation for the fields both /api/upload and /api/upload/complete
 * accept. Applying identical rules in both phases closes the gap where one
 * phase (complete) was looser than the other. Deliberately has no gcsKey
 * field — callers derive that themselves via deriveGcsKey once validation
 * succeeds, so a client-supplied gcsKey is never even read, let alone used.
 */
export function validateUploadMeta(input: UploadMetaInput): UploadMetaValidation {
  const sha256 = typeof input.sha256 === 'string' ? normalizeSha256(input.sha256) : null;
  if (!sha256) {
    return { ok: false, error: 'Invalid sha256' };
  }

  const { filename, contentType, size } = input;
  if (typeof filename !== 'string' || !filename) {
    return { ok: false, error: 'Missing required fields' };
  }
  if (typeof contentType !== 'string' || !contentType) {
    return { ok: false, error: 'Missing required fields' };
  }
  if (size == null) {
    return { ok: false, error: 'Missing required fields' };
  }

  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0 || size > MAX_FILE_SIZE) {
    return { ok: false, error: 'Invalid file size' };
  }

  if (contentType.length > MAX_CONTENT_TYPE_LENGTH || !CONTENT_TYPE_PATTERN.test(contentType)) {
    return { ok: false, error: 'Invalid content type' };
  }

  return { ok: true, data: { sha256, filename, contentType, size } };
}
