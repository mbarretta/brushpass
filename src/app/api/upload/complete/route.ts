export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { insertFile } from '@/lib/db';
import { generateToken, hashToken } from '@/lib/token';
import { parseExpiresAt, parseExpiresIn } from '@/lib/expiry';
import { statObject } from '@/lib/gcs';
import { deriveGcsKey, validateUploadMeta, type UploadMetaInput } from '@/lib/upload-meta';
import { auth } from '@/auth';
import { resolveUploadActor } from '@/lib/upload-auth';

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Authorize via cookie session, falling back to a minted agent Bearer key.
  const session = await resolveUploadActor(await auth(), request);
  const permissions: string[] = session?.user?.permissions ?? [];
  if (!permissions.includes('upload') && !permissions.includes('admin')) {
    console.log('[upload] phase=complete result=forbidden user=%s', session?.user?.username ?? 'unauthenticated');
    return NextResponse.json({ error: 'Forbidden', phase: 'complete' }, { status: 403 });
  }

  try {
    // Deliberately NOT read from the body — a caller-supplied gcsKey is
    // never honored. The object key is derived server-side below from the
    // same validated sha256 + filename that /api/upload used.
    const body = await request.json() as UploadMetaInput & {
      expires_in?: string;
      expires_at?: string;
    };

    const validated = validateUploadMeta(body);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error, phase: 'complete' }, { status: 400 });
    }
    const { sha256, filename, contentType } = validated.data;
    const { expires_in, expires_at } = body;

    const gcsKey = deriveGcsKey(sha256, filename);

    // Verify the object actually exists before recording anything — this is
    // what stops a caller from registering a key that was never uploaded
    // (or was uploaded somewhere else), and it's why the persisted size
    // below comes from GCS, not from the request body.
    const objectMeta = await statObject(gcsKey);
    if (!objectMeta) {
      console.log('[upload] phase=complete result=object-missing sha256=%s gcsKey=%s', sha256, gcsKey);
      return NextResponse.json({ error: 'Uploaded object not found', phase: 'complete' }, { status: 400 });
    }

    const uploadedBy = session?.user?.username ?? session?.user?.email ?? null;

    const resolveExpiry = (fallback: number | null) =>
      expires_in
        ? parseExpiresIn(expires_in)
        : expires_at
          ? parseExpiresAt(expires_at)
          : fallback;

    const expiresAtTs = resolveExpiry(null);
    const token = generateToken();
    const tokenHash = await hashToken(token);

    const record = insertFile({
      filename: gcsKey,
      original_name: filename,
      sha256,
      size: objectMeta.size,
      content_type: contentType,
      gcs_key: gcsKey,
      token_hash: tokenHash,
      expires_at: expiresAtTs,
      uploaded_by: uploadedBy,
    });

    console.log('[upload] phase=complete file=%d sha256=%s size=%d', record.id, record.sha256, record.size);

    return NextResponse.json({
      id: record.id,
      url: `/${record.sha256}`,
      token,
      expires_at: record.expires_at,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[upload] phase=complete error=%s', message);
    // Unique constraint violation — a concurrent upload of the same sha256
    // won this race between /api/upload's collision check and this insert.
    if (message.includes('UNIQUE constraint failed')) {
      return NextResponse.json({ error: 'File already exists', phase: 'complete' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Internal server error', phase: 'complete' }, { status: 500 });
  }
}
