export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { insertFile } from '@/lib/db';
import { generateToken, hashToken } from '@/lib/token';
import { parseExpiresAt, parseExpiresIn } from '@/lib/expiry';
import { isValidSha256 } from '@/lib/sha256';
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
    const body = await request.json() as {
      sha256?: string;
      gcsKey?: string;
      filename?: string;
      contentType?: string;
      size?: number;
      expires_in?: string;
      expires_at?: string;
    };

    const { sha256, gcsKey, filename, contentType, size, expires_in, expires_at } = body;

    if (!sha256 || !isValidSha256(sha256)) {
      return NextResponse.json({ error: 'Invalid sha256', phase: 'complete' }, { status: 400 });
    }
    if (!gcsKey || !filename || !contentType || size == null) {
      return NextResponse.json({ error: 'Missing required fields', phase: 'complete' }, { status: 400 });
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
      size,
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
    return NextResponse.json({ error: message, phase: 'complete' }, { status: 500 });
  }
}
