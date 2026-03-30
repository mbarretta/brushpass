export const runtime = 'nodejs';

import { type NextRequest } from 'next/server';
import { Readable } from 'stream';
import { getFileByMd5, logDownload } from '@/lib/db';
import { verifyToken } from '@/lib/token';
import { getGCSReadStream } from '@/lib/gcs';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ md5: string }> },
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
    const { md5 } = await params;

    // Look up the file record
    phase = 'db-lookup';
    const record = getFileByMd5(md5);
    if (!record) {
      return Response.json({ error: 'File not found', phase: 'db-lookup' }, { status: 404 });
    }

    // Expiry check
    phase = 'expiry-check';
    if (record.expires_at !== null && Math.floor(Date.now() / 1000) > record.expires_at) {
      console.error('[download] phase=%s error=%s md5=%s', 'expiry-check', 'File has expired', md5);
      return Response.json({ error: 'File has expired', phase: 'expiry-check' }, { status: 410 });
    }

    // Token required
    if (!token) {
      console.error('[download] phase=%s error=%s md5=%s', 'token-extract', 'Token required', md5);
      return Response.json({ error: 'Token required', phase: 'token-extract' }, { status: 401 });
    }

    // Verify token against stored bcrypt hash
    phase = 'token-verify';
    const valid = await verifyToken(token, record.token_hash);
    if (!valid) {
      console.error('[download] phase=%s error=%s md5=%s', 'token-verify', 'Invalid token', md5);
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

    // Open GCS read stream and convert to Web ReadableStream
    phase = 'gcs-stream';
    const nodeStream = getGCSReadStream(record.gcs_key);
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

    console.log('[download] file=%d md5=%s', record.id, md5);

    const enc = encodeURIComponent(record.original_name);
    return new Response(webStream, {
      headers: {
        'Content-Type': record.content_type,
        'Content-Disposition': `attachment; filename="${enc}"; filename*=UTF-8''${enc}`,
        'Content-Length': String(record.size),
      },
    });
  } catch (err) {
    console.error('[download] phase=%s error=%s', phase, String(err));
    return Response.json({ error: 'Internal server error', phase }, { status: 500 });
  }
}
