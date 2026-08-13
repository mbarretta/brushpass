export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { generateSignedUploadUrl } from '@/lib/gcs';
import { getFileBySha256 } from '@/lib/db';

import { deriveGcsKey, validateUploadMeta, type UploadMetaInput } from '@/lib/upload-meta';
import { auth } from '@/auth';
import { resolveUploadActor } from '@/lib/upload-auth';
import { readJson } from '@/lib/http';

export async function POST(request: NextRequest): Promise<Response> {
  // Authorize via cookie session, falling back to a minted agent Bearer key.
  const session = await resolveUploadActor(await auth(), request);
  const permissions: string[] = session?.user?.permissions ?? [];
  if (!permissions.includes('upload') && !permissions.includes('admin')) {
    console.log('[upload] phase=prepare result=forbidden user=%s', session?.user?.username ?? 'unauthenticated');
    return NextResponse.json({ error: 'Forbidden', phase: 'prepare' }, { status: 403 });
  }

  try {
    const parsed = await readJson(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as UploadMetaInput;

    const validated = validateUploadMeta(body);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error, phase: 'prepare' }, { status: 400 });
    }
    const { sha256, filename, contentType } = validated.data;

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

    // Derive the GCS object key server-side — the only producer of object
    // keys, shared with /api/upload/complete. Never accepted from the client.
    const gcsKey = deriveGcsKey(sha256, filename);

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
    return NextResponse.json({ error: 'Internal server error', phase: 'prepare' }, { status: 500 });
  }
}
