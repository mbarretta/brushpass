export const runtime = 'nodejs';

import { type NextRequest } from 'next/server';
import { getGroupWithFiles } from '@/lib/db';
import { verifyToken } from '@/lib/token';
import { isValidSha256 } from '@/lib/sha256';
import { generateSignedDownloadUrl } from '@/lib/gcs';

type Params = { params: Promise<{ slug: string; sha256: string }> };

export async function GET(request: NextRequest, { params }: Params): Promise<Response> {
  let phase = 'params';
  try {
    const { slug, sha256 } = await params;

    if (!isValidSha256(sha256)) {
      return Response.json({ error: 'Not found', phase: 'validation' }, { status: 404 });
    }

    phase = 'token-extract';
    const url = new URL(request.url);
    const token = url.searchParams.get('token') ?? null;
    if (!token) {
      return Response.json({ error: 'Token required', phase: 'token-extract' }, { status: 401 });
    }

    phase = 'db-lookup';
    const group = getGroupWithFiles(slug);
    if (!group) {
      return Response.json({ error: 'Group not found', phase: 'db-lookup' }, { status: 404 });
    }

    phase = 'expiry-check';
    if (group.expires_at !== null && Math.floor(Date.now() / 1000) > group.expires_at) {
      return Response.json({ error: 'Group has expired', phase: 'expiry-check' }, { status: 410 });
    }

    phase = 'token-verify';
    const valid = await verifyToken(token, group.token_hash);
    if (!valid) {
      return Response.json({ error: 'Invalid token', phase: 'token-verify' }, { status: 401 });
    }

    phase = 'file-lookup';
    const file = group.files.find((f) => f.sha256 === sha256);
    if (!file) {
      return Response.json({ error: 'File not in group', phase: 'file-lookup' }, { status: 404 });
    }

    phase = 'gcs-sign';
    const signedUrl = await generateSignedDownloadUrl(
      file.gcs_key,
      file.original_name,
      file.content_type,
    );

    console.log('[group-download] group=%s file=%d sha256=%s', slug, file.id, sha256);
    return Response.redirect(signedUrl, 302);
  } catch (err) {
    console.error('[group-download] phase=%s error=%s', phase, String(err));
    return Response.json({ error: 'Internal server error', phase }, { status: 500 });
  }
}
