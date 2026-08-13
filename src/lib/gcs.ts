import { Storage } from '@google-cloud/storage';
import { Readable } from 'stream';

const bucketName = process.env.GCS_BUCKET;
if (!bucketName) throw new Error('GCS_BUCKET env var is required');

const storage = new Storage(
  process.env.GCS_SERVICE_ACCOUNT_EMAIL
    ? { email: process.env.GCS_SERVICE_ACCOUNT_EMAIL }
    : {},
); // uses ADC, GOOGLE_APPLICATION_CREDENTIALS, or IAM signBlob via GCS_SERVICE_ACCOUNT_EMAIL
const bucket = storage.bucket(bucketName);

export async function deleteFromGCS(gcsKey: string): Promise<void> {
  await bucket.file(gcsKey).delete();
}

export interface GCSObjectMeta {
  size: number;
  contentType: string | null;
}

/**
 * Look up an object's metadata without downloading it. Returns null when
 * the object does not exist (404) — the caller decides what that means —
 * and rethrows any other error. Used to verify that a client actually PUT
 * something to the signed upload URL before /api/upload/complete records
 * it, and to source the persisted size from GCS rather than trusting the
 * request body.
 */
export async function statObject(gcsKey: string): Promise<GCSObjectMeta | null> {
  try {
    const [metadata] = await bucket.file(gcsKey).getMetadata();
    const size = typeof metadata.size === 'string' ? parseInt(metadata.size, 10) : (metadata.size ?? 0);
    return { size, contentType: metadata.contentType ?? null };
  } catch (err) {
    if (err instanceof Error && (err as { code?: number }).code === 404) return null;
    throw err;
  }
}

export function getGCSReadStream(gcsKey: string): Readable {
  return bucket.file(gcsKey).createReadStream() as unknown as Readable;
}

/** Rename a GCS object from oldKey to newKey. Returns the new key. */
export async function renameInGCS(oldKey: string, newKey: string): Promise<void> {
  await bucket.file(oldKey).rename(newKey);
}

/**
 * Generate a signed GET URL for direct browser-to-GCS download.
 * Redirecting to this URL bypasses the Cloud Run 32MB response size limit.
 * Default TTL is 15 minutes (900 s); adjust via expiresInSeconds.
 */
export async function generateSignedDownloadUrl(
  gcsKey: string,
  originalName: string,
  contentType: string,
  expiresInSeconds = 900,
): Promise<string> {
  const enc = encodeURIComponent(originalName);
  const [url] = await bucket.file(gcsKey).getSignedUrl({
    action: 'read' as const,
    version: 'v4',
    expires: Date.now() + expiresInSeconds * 1000,
    responseDisposition: `attachment; filename="${enc}"; filename*=UTF-8''${enc}`,
    responseType: contentType,
  });
  return url;
}

/**
 * Generate a signed PUT URL for direct browser-to-GCS upload.
 * The caller must PUT to the returned URL with the same Content-Type header.
 * Default TTL is 15 minutes (900 s); adjust via expiresInSeconds.
 */
export async function generateSignedUploadUrl(
  gcsKey: string,
  contentType: string,
  expiresInSeconds = 900,
): Promise<string> {
  const [url] = await bucket.file(gcsKey).getSignedUrl({
    action: 'write' as const,
    version: 'v4',
    expires: Date.now() + expiresInSeconds * 1000,
    contentType,
  });
  return url;
}
