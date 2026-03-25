export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import busboy from 'busboy';
import { Readable } from 'stream';
import path from 'path';
import crypto from 'crypto';
import { computeMD5AndStream } from '@/lib/md5';
import { streamToGCS, deleteFromGCS, renameInGCS } from '@/lib/gcs';
import { insertFile, getFileByMd5, getDb } from '@/lib/db';
import { generateToken, hashToken } from '@/lib/token';

// TODO S04: verify session has 'upload' or 'admin' permission before processing

/** Map common MIME types to extensions when filename has none. */
function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/csv': 'csv',
    'application/json': 'json',
    'application/zip': 'zip',
    'application/octet-stream': 'bin',
  };
  return map[mime] ?? 'bin';
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let phase: 'busboy-parse' | 'gcs-upload' | 'db-insert' = 'busboy-parse';
  let tempGCSKey: string | null = null;

  try {
    const contentType = request.headers.get('content-type');
    if (!contentType?.startsWith('multipart/form-data')) {
      return NextResponse.json(
        { error: 'Content-Type must be multipart/form-data', phase: 'busboy-parse' },
        { status: 400 },
      );
    }

    // Convert WHATWG ReadableStream → Node.js Readable (requires Node ≥ 18)
    const nodeStream = Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]);

    // busboy requires plain object headers
    const headers = Object.fromEntries(request.headers.entries());

    // Parse expires_at and file from multipart body.
    // We use a mutable ref for expiresAt so fields that arrive AFTER the file part
    // (valid per multipart/form-data spec) are still captured before we use the value.
    const fieldValues: Record<string, string> = {};

    const result = await new Promise<{
      fileStream: Readable;
      filename: string;
      mimeType: string;
    }>((resolve, reject) => {
      const bb = busboy({ headers });
      let settled = false;

      // Collect all text field values; may arrive before or after the file part
      bb.on('field', (name: string, value: string) => {
        fieldValues[name] = value;
      });

      bb.on('file', (_fieldname: string, fileStream: Readable, info: busboy.FileInfo) => {
        const { filename, mimeType } = info;
        settled = true;
        // Resolve with the live stream — caller must consume it before busboy finishes
        resolve({ fileStream, filename: filename || 'upload', mimeType });
      });

      bb.on('error', (err: Error) => { if (!settled) { settled = true; reject(err); } });
      bb.on('close', () => {
        // Only reject if no file was found (file event fires before close)
        if (!settled) { settled = true; reject(new Error('No file field in multipart body')); }
      });

      nodeStream.pipe(bb);
    });

    const { fileStream, filename, mimeType } = result;
    // fieldValues is still being populated by busboy as we stream;
    // it will be fully populated by the time Promise.all resolves below.

    // Derive extension from filename or MIME type
    const rawExt = path.extname(filename).replace('.', '') || mimeToExt(mimeType);
    const ext = rawExt.toLowerCase();

    // Generate a temp GCS key using a UUID so we can start streaming immediately
    // before the MD5 is known
    tempGCSKey = `tmp/${crypto.randomUUID()}`;

    // Set up MD5 tee-stream — passThrough is both consumed by MD5 hash AND piped to GCS
    const { md5Promise, sizePromise, passThrough } = computeMD5AndStream(fileStream);

    // Start GCS upload from the passThrough stream immediately
    phase = 'gcs-upload';
    const gcsUploadPromise = streamToGCS(passThrough, tempGCSKey, mimeType);

    // Await GCS upload completion, MD5, and byte count in parallel
    const [md5, size] = await Promise.all([
      md5Promise,
      sizePromise,
      gcsUploadPromise,
    ]);

    const finalGCSKey = `${md5}.${ext}`;

    // Check for MD5 collision — file already uploaded with same content
    const existing = getFileByMd5(md5);
    if (existing) {
      // Clean up the temp object — the canonical one already exists
      try {
        await deleteFromGCS(tempGCSKey);
      } catch (delErr) {
        console.error('[upload] phase=gcs-cleanup error=%s (non-fatal)', (delErr as Error).message);
      }
      tempGCSKey = null;

      // Issue a fresh token for the existing record
      const token = generateToken();
      const tokenHash = await hashToken(token);

      // Update the token_hash for the existing record
      // (re-use the existing record's expiry; caller may not have sent expires_at)
      const expiresAtTs = fieldValues['expires_at'] ? parseExpiresAt(fieldValues['expires_at']) : existing.expires_at;

      phase = 'db-insert';
      getDb().prepare('UPDATE files SET token_hash = ?, expires_at = ? WHERE id = ?').run(
        tokenHash,
        expiresAtTs,
        existing.id,
      );

      console.log('[upload] collision file=%d md5=%s size=%d', existing.id, existing.md5, existing.size);

      return NextResponse.json({
        url: `/${existing.md5}`,
        token,
        expires_at: expiresAtTs,
      });
    }

    // Rename the temp GCS object to the final content-addressed key
    phase = 'gcs-upload';
    await renameInGCS(tempGCSKey, finalGCSKey);
    tempGCSKey = null; // successfully renamed; finalGCSKey is now the live object

    // Parse expires_at into a Unix timestamp (null = no expiry)
    const expiresAtTs = fieldValues['expires_at'] ? parseExpiresAt(fieldValues['expires_at']) : null;

    // Generate a one-time download token
    const token = generateToken();
    const tokenHash = await hashToken(token);

    // Insert the DB record
    phase = 'db-insert';
    const record = insertFile({
      filename: finalGCSKey,
      original_name: filename,
      md5,
      size,
      content_type: mimeType,
      gcs_key: finalGCSKey,
      token_hash: tokenHash,
      expires_at: expiresAtTs,
      uploaded_by: null,
    });

    console.log('[upload] file=%d md5=%s size=%d', record.id, record.md5, record.size);

    return NextResponse.json({
      url: `/${record.md5}`,
      token,
      expires_at: record.expires_at,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[upload] phase=%s error=%s', phase, message);

    // Clean up orphaned temp GCS object if upload failed mid-flight
    if (tempGCSKey) {
      try {
        await deleteFromGCS(tempGCSKey);
      } catch { /* best-effort */ }
    }

    return NextResponse.json({ error: message, phase }, { status: 500 });
  }
}

/** Parse expires_at from ISO string or Unix timestamp string → number | null */
function parseExpiresAt(value: string): number | null {
  if (!value) return null;
  // Try as Unix timestamp (numeric string)
  const asNum = Number(value);
  if (!isNaN(asNum) && asNum > 0) return asNum;
  // Try as ISO 8601
  const asDate = new Date(value);
  if (!isNaN(asDate.getTime())) return Math.floor(asDate.getTime() / 1000);
  return null;
}
