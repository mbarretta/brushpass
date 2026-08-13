export const runtime = 'nodejs';

import { type NextRequest } from 'next/server';
import { getFileBySha256ForAuth, logDownload } from '@/lib/db';
import { verifySecret } from '@/lib/token';
import { isValidSha256 } from '@/lib/sha256';
import { generateSignedDownloadUrl } from '@/lib/gcs';
import { extractBearerToken, readJson } from '@/lib/http';

type Params = { params: Promise<{ sha256: string }> };

/**
 * The single answer every failed authorization gets, byte for byte.
 *
 * A caller who does not hold a valid token must not be able to tell an unknown
 * digest from a real-but-expired file from a wrong token — otherwise this route
 * is an oracle that confirms "this exact content exists in this bucket" to
 * anyone who can guess or obtain a hash from elsewhere. It was the last such
 * oracle in the app: the group routes were reordered for the same reason.
 *
 * `phase` is deliberately constant too (a varying phase would rebuild the
 * oracle out of the debug field); the real reason is written to the server log
 * instead.
 */
const UNAUTHORIZED_BODY = { error: 'Invalid token', phase: 'token-verify' };

function unauthorized(): Response {
  return Response.json(UNAUTHORIZED_BODY, { status: 401 });
}

type Authorization =
  | { ok: true; url: string }
  | { ok: false; response: Response };

/**
 * Carries the current step out of {@link authorizeDownload} so the handler's
 * catch can name it. Both handlers report `phase` in the 500 body and the error
 * log, which is how this repo triages a failure; without this the whole helper
 * would collapse to a single uninformative phase and a GCS signing failure
 * would be indistinguishable from a database one.
 */
type PhaseRef = { phase: string };

/**
 * Resolves a download request to a signed GCS URL, or to the response to
 * return instead.
 *
 * ORDER IS THE SECURITY PROPERTY HERE. Existence and expiry are both answered
 * strictly AFTER the token verifies:
 *
 *  1. malformed digest -> 404. Not an oracle: whether a string is 64 hex
 *     characters is something the caller already knows without asking us.
 *  2. no token at all -> the constant 401, without touching the database.
 *     Also not an oracle (the caller knows they sent nothing), and it keeps an
 *     anonymous flood from spending a bcrypt compare per request.
 *  3. exactly one bcrypt compare, against a dummy hash when the row is absent,
 *     so an unknown digest and a wrong token cost the same work and return the
 *     same bytes.
 *  4. only now, holding a verified token, may the caller learn that the file
 *     exists but has expired (410).
 */
async function authorizeDownload(
  sha256: string,
  token: string | null,
  ctx: PhaseRef,
): Promise<Authorization> {
  ctx.phase = 'validation';
  if (!isValidSha256(sha256)) {
    return { ok: false, response: Response.json({ error: 'Not found', phase: 'validation' }, { status: 404 }) };
  }

  if (!token) {
    console.error('[download] phase=%s error=%s sha256=%s', 'token-extract', 'Token required', sha256);
    return { ok: false, response: unauthorized() };
  }

  // Needs token_hash below — the ForAuth variant is the one production caller.
  ctx.phase = 'db-lookup';
  const record = getFileBySha256ForAuth(sha256);

  // verifySecret is the shared constant-work comparator: passing null spends
  // one compare against a fixed dummy hash, so the absent-record path costs the
  // same as the wrong-token path.
  ctx.phase = 'token-verify';
  const valid = await verifySecret(token, record?.token_hash ?? null);
  if (!record || !valid) {
    // warn, not error: client misbehavior, aligned with the group access and
    // group-download rejection logs.
    console.warn(
      '[download] phase=%s error=%s sha256=%s',
      'token-verify',
      record ? 'Invalid token' : 'Unknown sha256',
      sha256,
    );
    return { ok: false, response: unauthorized() };
  }

  ctx.phase = 'expiry-check';
  if (record.expires_at !== null && Math.floor(Date.now() / 1000) > record.expires_at) {
    console.error('[download] phase=%s error=%s sha256=%s', 'expiry-check', 'File has expired', sha256);
    return {
      ok: false,
      response: Response.json({ error: 'File has expired', phase: 'expiry-check' }, { status: 410 }),
    };
  }

  // Log the download before signing (better-sqlite3 is synchronous)
  ctx.phase = 'db-log';
  try {
    logDownload(record.id);
  } catch (logErr) {
    // Non-fatal: log but continue serving the file
    console.error('[download] phase=%s error=%s', 'db-log', String(logErr));
  }

  ctx.phase = 'gcs-sign';
  const url = await generateSignedDownloadUrl(record.gcs_key, record.original_name, record.content_type);
  console.log('[download] file=%d sha256=%s', record.id, sha256);
  return { ok: true, url };
}

/**
 * GET — the shareable-link path, kept for links already in circulation:
 * `?token=` in the query string, or an `Authorization: Bearer` header for API
 * callers. Redirects to the signed GCS URL, which bypasses Cloud Run's 32MB
 * response cap and supports files of any size.
 *
 * The query-string form is why POST exists: a token in a URL is written to
 * Cloud Logging on every request. Browsers now use POST (below); this stays for
 * compatibility.
 */
export async function GET(request: NextRequest, { params }: Params): Promise<Response> {
  const ctx: PhaseRef = { phase: 'init' };
  try {
    ctx.phase = 'token-extract';
    const url = new URL(request.url);
    const token = url.searchParams.get('token') ?? extractBearerToken(request);

    const { sha256 } = await params;
    const result = await authorizeDownload(sha256, token, ctx);
    if (!result.ok) return result.response;

    return Response.redirect(result.url, 302);
  } catch (err) {
    console.error('[download] phase=%s error=%s', ctx.phase, String(err));
    return Response.json({ error: 'Internal server error', phase: ctx.phase }, { status: 500 });
  }
}

/**
 * POST — the browser path. Takes the token in the request BODY and returns
 * `{ url }` for the client to navigate to, so the token never appears in a URL
 * and therefore never reaches Cloud Logging, the browser's history, or a
 * Referer header. An `Authorization: Bearer` header works too and takes
 * precedence, which also lets an API caller POST with no body at all.
 */
export async function POST(request: NextRequest, { params }: Params): Promise<Response> {
  const ctx: PhaseRef = { phase: 'init' };
  try {
    ctx.phase = 'token-extract';
    let token = extractBearerToken(request);
    if (!token) {
      ctx.phase = 'body-parse';
      const parsed = await readJson(request);
      if (!parsed.ok) return parsed.response;
      const { token: bodyToken } = (parsed.body ?? {}) as Record<string, unknown>;
      token = typeof bodyToken === 'string' && bodyToken !== '' ? bodyToken : null;
    }

    const { sha256 } = await params;
    const result = await authorizeDownload(sha256, token, ctx);
    if (!result.ok) return result.response;

    return Response.json({ url: result.url });
  } catch (err) {
    console.error('[download] phase=%s error=%s', ctx.phase, String(err));
    return Response.json({ error: 'Internal server error', phase: ctx.phase }, { status: 500 });
  }
}
