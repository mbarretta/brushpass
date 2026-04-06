export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import busboy from 'busboy';
import { Readable } from 'stream';
import path from 'path';
import crypto from 'crypto';
import { computeSHA256AndStream } from '@/lib/sha256';
import { streamToGCS, deleteFromGCS, renameInGCS } from '@/lib/gcs';
import { insertFile, getFileBySha256, updateFileTokenHash, updateFileExpiry } from '@/lib/db';
import { generateToken, hashToken } from '@/lib/token';
import { parseExpiresAt, parseExpiresIn } from '@/lib/expiry';
import { auth } from '@/auth';

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
  // Verify session has upload or admin permission
  const session = await auth();
  const permissions: string[] = session?.user?.permissions ?? [];
  if (!permissions.includes('upload') && !permissions.includes('admin')) {
    console.log('[upload] phase=auth result=forbidden user=%s', session?.user?.username ?? 'unauthenticated');
    return NextResponse.json({ error: 'Forbidden', phase: 'auth' }, { status: 403 });
  }
  const uploadedBy = session?.user?.username ?? session?.user?.email ?? null;

  let phase: 'busboy-parse' | 'gcs-upload' | 'db-insert' | 'db-update' = 'busboy-parse';
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
    // before the SHA-256 is known
    tempGCSKey = `tmp/${crypto.randomUUID()}`;

    // Set up SHA-256 tee-stream — passThrough is both consumed by SHA-256 hash AND piped to GCS
    const { sha256Promise, sizePromise, passThrough } = computeSHA256AndStream(fileStream);

    // Start GCS upload from the passThrough stream immediately
    phase = 'gcs-upload';
    const gcsUploadPromise = streamToGCS(passThrough, tempGCSKey, mimeType);

    // Await GCS upload completion, SHA-256, and byte count in parallel
    const [sha256, size] = await Promise.all([
      sha256Promise,
      sizePromise,
      gcsUploadPromise,
    ]);

    const finalGCSKey = `${sha256}.${ext}`;

    const resolveExpiry = (fallback: number | null) =>
      fieldValues['expires_in']
        ? parseExpiresIn(fieldValues['expires_in'])
        : fieldValues['expires_at']
          ? parseExpiresAt(fieldValues['expires_at'])
          : fallback;

    // Check for SHA-256 collision — file already uploaded with same content
    const existing = getFileBySha256(sha256);
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

      const expiresAtTs = resolveExpiry(existing.expires_at);

      phase = 'db-update';
      updateFileTokenHash(existing.id, tokenHash);
      updateFileExpiry(existing.id, expiresAtTs);

      console.log('[upload] collision file=%d sha256=%s size=%d', existing.id, existing.sha256, existing.size);

      return NextResponse.json({
        url: `/${existing.sha256}`,
        token,
        expires_at: expiresAtTs,
      });
    }

    // Rename the temp GCS object to the final content-addressed key
    phase = 'gcs-upload';
    await renameInGCS(tempGCSKey, finalGCSKey);
    tempGCSKey = null; // successfully renamed; finalGCSKey is now the live object

    const expiresAtTs = resolveExpiry(null);

    // Generate a one-time download token
    const token = generateToken();
    const tokenHash = await hashToken(token);

    // Insert the DB record
    phase = 'db-insert';
    const record = insertFile({
      filename: finalGCSKey,
      original_name: filename,
      sha256,
      size,
      content_type: mimeType,
      gcs_key: finalGCSKey,
      token_hash: tokenHash,
      expires_at: expiresAtTs,
      uploaded_by: uploadedBy,
    });

    console.log('[upload] file=%d sha256=%s size=%d', record.id, record.sha256, record.size);

    return NextResponse.json({
      url: `/${record.sha256}`,
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
