export const runtime = 'nodejs';

import { type NextRequest } from 'next/server';
import { getFileBySha256, logDownload } from '@/lib/db';
import { verifyToken } from '@/lib/token';
import { isValidSha256 } from '@/lib/sha256';
import { generateSignedDownloadUrl } from '@/lib/gcs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sha256: string }> },
): Promise<Response> {
  let phase = 'init';
  try {
    // Extract token: query param takes priority over Authorization header
    phase = 'token-extract';
    const url = new URL(request.url);
    const token =
      url.searchParams.get('token') ??
      request.headers.get('authorization')?.replace('Bearer ', '') ??
      null;

    // Resolve params (Promise in Next.js 15+/16)
    const { sha256 } = await params;

    if (!isValidSha256(sha256)) {
      return Response.json({ error: 'Not found', phase: 'validation' }, { status: 404 });
    }

    // Look up the file record
    phase = 'db-lookup';
    const record = getFileBySha256(sha256);
    if (!record) {
      return Response.json({ error: 'File not found', phase: 'db-lookup' }, { status: 404 });
    }

    // Expiry check
    phase = 'expiry-check';
    if (record.expires_at !== null && Math.floor(Date.now() / 1000) > record.expires_at) {
      console.error('[download] phase=%s error=%s sha256=%s', 'expiry-check', 'File has expired', sha256);
      return Response.json({ error: 'File has expired', phase: 'expiry-check' }, { status: 410 });
    }

    // Token required
    if (!token) {
      console.error('[download] phase=%s error=%s sha256=%s', 'token-extract', 'Token required', sha256);
      return Response.json({ error: 'Token required', phase: 'token-extract' }, { status: 401 });
    }

    // Verify token against stored bcrypt hash
    phase = 'token-verify';
    const valid = await verifyToken(token, record.token_hash);
    if (!valid) {
      console.error('[download] phase=%s error=%s sha256=%s', 'token-verify', 'Invalid token', sha256);
      return Response.json({ error: 'Invalid token', phase: 'token-verify' }, { status: 401 });
    }

    // Log the download before streaming (better-sqlite3 is synchronous)
    phase = 'db-log';
    try {
      logDownload(record.id);
    } catch (logErr) {
      // Non-fatal: log but continue serving the file
      console.error('[download] phase=%s error=%s', 'db-log', String(logErr));
    }

    // Generate a short-lived signed GCS URL and redirect the client directly.
    // Streaming through Cloud Run hits a 32MB response size limit — redirecting
    // to GCS bypasses the proxy entirely and supports files of any size.
    phase = 'gcs-sign';
    const signedUrl = await generateSignedDownloadUrl(
      record.gcs_key,
      record.original_name,
      record.content_type,
    );

    console.log('[download] file=%d sha256=%s', record.id, sha256);

    return Response.redirect(signedUrl, 302);
  } catch (err) {
    console.error('[download] phase=%s error=%s', phase, String(err));
    return Response.json({ error: 'Internal server error', phase }, { status: 500 });
  }
}
