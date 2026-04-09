export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { generateSignedUploadUrl } from '@/lib/gcs';
import { getFileBySha256 } from '@/lib/db';

import { parseExpiresAt, parseExpiresIn } from '@/lib/expiry';
import { isValidSha256 } from '@/lib/sha256';
import { auth } from '@/auth';

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Verify session has upload or admin permission
  const session = await auth();
  const permissions: string[] = session?.user?.permissions ?? [];
  if (!permissions.includes('upload') && !permissions.includes('admin')) {
    console.log('[upload] phase=prepare result=forbidden user=%s', session?.user?.username ?? 'unauthenticated');
    return NextResponse.json({ error: 'Forbidden', phase: 'prepare' }, { status: 403 });
  }

  try {
    const body = await request.json() as {
      sha256?: string;
      filename?: string;
      contentType?: string;
      size?: number;
      expires_in?: string;
      expires_at?: string;
    };

    const { sha256, filename, contentType, size, expires_in, expires_at } = body;

    // Validate sha256
    if (!sha256 || !isValidSha256(sha256)) {
      return NextResponse.json({ error: 'Invalid sha256', phase: 'prepare' }, { status: 400 });
    }
    if (!filename || !contentType || size == null) {
      return NextResponse.json({ error: 'Missing required fields', phase: 'prepare' }, { status: 400 });
    }
    const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024; // 10 GB
    if (typeof size !== 'number' || size <= 0 || size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'Invalid file size', phase: 'prepare' }, { status: 400 });
    }
    // Basic MIME type format validation: type/subtype with optional suffix/params
    if (typeof contentType !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*/.test(contentType)) {
      return NextResponse.json({ error: 'Invalid content type', phase: 'prepare' }, { status: 400 });
    }

    const resolveExpiry = (fallback: number | null) =>
      expires_in
        ? parseExpiresIn(expires_in)
        : expires_at
          ? parseExpiresAt(expires_at)
          : fallback;

    // Collision check — file with this SHA-256 already uploaded.
    // Return the existing file's URL without generating or returning a token.
    // The original uploader's token is preserved unchanged.
    const existing = getFileBySha256(sha256);
    if (existing) {
      console.log('[upload] phase=prepare collision file=%d sha256=%s', existing.id, sha256);
      return NextResponse.json({
        type: 'collision',
        url: `/${existing.sha256}`,
        expires_at: existing.expires_at,
      });
    }

    // Derive GCS key from sha256 + extension from filename
    const rawExt = path.extname(filename).replace('.', '') || 'bin';
    const ext = rawExt.toLowerCase();
    const gcsKey = `${sha256}.${ext}`;

    const signedUrl = await generateSignedUploadUrl(gcsKey, contentType);

    console.log('[upload] phase=prepare new sha256=%s gcsKey=%s', sha256, gcsKey);
    return NextResponse.json({
      type: 'upload',
      signedUrl,
      gcsKey,
      contentType,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[upload] phase=prepare error=%s', message);
    return NextResponse.json({ error: message, phase: 'prepare' }, { status: 500 });
  }
}
