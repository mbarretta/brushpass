export const runtime = 'nodejs';

import { type NextRequest } from 'next/server';
import { getGroupBySlugForAuth, listGroupFiles } from '@/lib/db';
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
    // Prefer Authorization: Bearer header; fall back to ?token= query param for
    // backwards compatibility. The header avoids token exposure in logs/history.
    const authHeader = request.headers.get('authorization') ?? '';
    const url = new URL(request.url);
    const token =
      (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null) ??
      url.searchParams.get('token');
    if (!token) {
      return Response.json({ error: 'Token required', phase: 'token-extract' }, { status: 401 });
    }

    // Verify the group and the token BEFORE loading any file rows — avoids
    // loading the group's full file list for a caller who has not yet proven
    // they hold a valid token. getGroupBySlugForAuth is the one production
    // caller that needs token_hash off the file_groups row.
    phase = 'db-lookup';
    const group = getGroupBySlugForAuth(slug);
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
    const files = listGroupFiles(group.id);
    const file = files.find((f) => f.sha256 === sha256);
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

    // When called via fetch() (Authorization header path), proxy the bytes so the
    // client can blob-download without exposing the signed GCS URL or the token in
    // the URL bar. For backwards-compatible ?token= redirect path, keep the redirect.
    if (authHeader.startsWith('Bearer ')) {
      const gcsRes = await fetch(signedUrl);
      return new Response(gcsRes.body, {
        headers: {
          'Content-Type': file.content_type,
          'Content-Disposition': `attachment; filename="${encodeURIComponent(file.original_name)}"`,
        },
      });
    }
    return Response.redirect(signedUrl, 302);
  } catch (err) {
    console.error('[group-download] phase=%s error=%s', phase, String(err));
    return Response.json({ error: 'Internal server error', phase }, { status: 500 });
  }
}
