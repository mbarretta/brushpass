/**
 * Shared HTTP request helpers.
 *
 * Three primitives that were previously hand-rolled once per route handler, in
 * mutually inconsistent ways:
 *
 *  - {@link parseId} replaces `parseInt(id, 10)` + `isNaN` at the five
 *    dynamic-`[id]` API routes. `parseInt` parses a numeric PREFIX, so
 *    `parseInt('1.png', 10)` is `1` — a request to `/api/admin/users/1.png`
 *    addressed user 1 while also dodging the proxy matcher's static-extension
 *    exclusion. Validating the whole segment closes the coercion half of that.
 *  - {@link extractBearerToken} replaces three divergent parsers
 *    (`.replace('Bearer ', '')` on the download route and two
 *    `.slice(7)` sites). They disagreed about header case, extra whitespace,
 *    and — worst — what to do when the `Bearer` prefix was absent entirely.
 *  - {@link readJson} replaces the six-line try/catch idiom repeated at every
 *    body-reading route, so the malformed-body 400 is one shape everywhere.
 *
 * Deliberately free of node-only imports (only the universal `Request`/
 * `Response` globals are used) because `@/lib/agent-key` imports
 * {@link extractBearerToken} and agent-key runs inside the Edge proxy.
 */

/** Anything exposing `headers.get()`: `NextRequest`, `Request`, or a test stub. */
export interface HeaderSource {
  headers: { get(name: string): string | null };
}

/** A run of decimal digits and nothing else — no sign, no dot, no exponent. */
const DECIMAL_ID = /^\d+$/;

/**
 * Parses a route parameter that must be a positive-or-zero decimal integer id,
 * returning null when it is anything else.
 *
 * Two rejections matter beyond the obvious:
 *  - a numeric prefix followed by junk (`'1.png'`, `'12abc'`), which is exactly
 *    what `parseInt` accepted; and
 *  - a digit run too long to survive `Number()` exactly, which would let two
 *    different URLs round to the same id.
 */
export function parseId(raw: string): number | null {
  if (!DECIMAL_ID.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Extracts the bearer token from a request's `Authorization` header.
 *
 * Returns the raw token, or null when the header is absent, empty, uses another
 * scheme, or carries no token after the scheme. The scheme match is
 * case-insensitive and tolerates repeated whitespace, per RFC 7235 — and,
 * unlike the `.replace('Bearer ', '')` form it replaces, a header with no
 * `Bearer` prefix at all yields null instead of being handed onward as if it
 * were a token.
 */
export function extractBearerToken(request: HeaderSource): string | null {
  const header = request.headers.get('authorization') ?? request.headers.get('Authorization');
  if (!header) return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token === '' ? null : token;
}

/** Result of {@link readJson}: the parsed body, or the 400 to return verbatim. */
export type JsonBody =
  | { ok: true; body: unknown }
  | { ok: false; response: Response };

/**
 * Reads and parses a JSON request body, converting a malformed body into the
 * 400 the caller should return directly:
 *
 * ```ts
 * const parsed = await readJson(request);
 * if (!parsed.ok) return parsed.response;
 * ```
 *
 * The error body carries `phase: 'body-parse'` to match the repo's
 * `{ error, phase }` convention — the same phase every replaced call site used,
 * and fixed rather than a parameter because reading the body is always this
 * step whatever the handler calls the surrounding work.
 */
export async function readJson(request: { json(): Promise<unknown> }): Promise<JsonBody> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return {
      ok: false,
      response: Response.json({ error: 'Invalid JSON body', phase: 'body-parse' }, { status: 400 }),
    };
  }
}
