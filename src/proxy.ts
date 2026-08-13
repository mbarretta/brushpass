import { auth } from '@/auth';
import { resolveBearerAuth } from '@/lib/agent-key';
import { SECURITY_HEADERS } from '@/lib/security-headers';
import { getClientIp, getRateLimitCategory, isRateLimited } from '@/lib/throttle';
import { NextResponse } from 'next/server';

// ── Rate limiting ─────────────────────────────────────────────────────────────
// The sliding-window limiter, the client-IP resolution and the failed-login
// lockout all live in @/lib/throttle now, so the Node credentials path can share
// them (a path-keyed limiter here cannot see a login that arrives on a different
// transport). Re-exported so existing importers of @/proxy keep working; note
// that the Edge and Node runtimes each hold their own counter maps — see the
// header comment in @/lib/throttle.
export { getRateLimitCategory, isRateLimited };

export function isPublicRoute(pathname: string): boolean {
  // Auth.js own API routes
  if (pathname.startsWith('/api/auth/')) return true;
  // Agent device-grant endpoints (RFC 8628). These are unauthenticated-by-design:
  // the agent caller has no cookie session — it hits these precisely to obtain a
  // scoped upload key. They are self-protected by the device-grant flow and by the
  // device_start/device_token rate-limit categories (applied above, before this
  // check). Matched as exact paths so no other /api/agent/* route is exposed.
  if (pathname === '/api/agent/device/start') return true;
  if (pathname === '/api/agent/device/token') return true;
  // Login page
  if (pathname === '/login') return true;
  // Logout route — must be public so unauthenticated browsers aren't redirect-looped
  if (pathname === '/logout') return true;
  // Home page
  if (pathname === '/') return true;
  // Download route: /[sha256] — single path segment, no further nesting
  // Matches paths like /abc123def456... but NOT /admin or /upload
  if (/^\/[a-f0-9]{64}(\?.*)?$/i.test(pathname)) return true;
  // Generic download form page
  if (pathname === '/download') return true;
  // Request-access page — authenticated users with no permissions land here
  if (pathname === '/request-access') return true;
  // Download API
  if (pathname.startsWith('/api/download/')) return true;
  // Public group pages: /g/[slug]
  if (pathname.startsWith('/g/')) return true;
  // Group file download API
  if (pathname.startsWith('/api/groups/')) return true;
  return false;
}

/**
 * The two permission gates below are deliberately OPTIMISTIC: they read the
 * permissions carried in the JWT session cookie, which can be up to
 * `session.maxAge` old and therefore still assert rights the database has since
 * revoked.
 *
 * That is not a bug to fix here. This proxy runs on the Edge runtime and cannot
 * import better-sqlite3, so it has no way to re-read the users table. The
 * authoritative check is the DB-backed one inside each handler and page —
 * `getIsAdmin()` (@/lib/admin-auth) and `resolveUploadActor()`
 * (@/lib/upload-auth) — which run in Node and resolve permissions by
 * `session.user.id`. Treat this layer as a cheap early rejection for the common
 * case, never as the security boundary.
 */
function requiresAdmin(pathname: string): boolean {
  return pathname.startsWith('/admin') || pathname.startsWith('/api/admin');
}

function requiresUpload(pathname: string): boolean {
  return pathname === '/upload' || pathname.startsWith('/api/upload');
}

/**
 * Some non-browser routes authenticate themselves and must reach their own
 * handler instead of being redirected to /login when there is no cookie
 * session. Returns:
 *  - 'agent-key' for `/api/upload*`: gated here by resolveBearerAuth (a
 *    short-lived, jose-verified agent Bearer key) before the handler runs.
 *    Never the `/upload` page (browser/cookie surface) or admin routes
 *    (cookie-only by design).
 *  - 'route' for exactly `/api/cleanup`: the Edge proxy cannot verify the
 *    Cloud Scheduler's OIDC identity token itself (no DB/service-account
 *    access at the Edge), so it only lets a request that carries an
 *    Authorization header through to the route's own verification — a
 *    request with no Authorization header at all still falls through to the
 *    /login redirect, so deny-by-default is preserved (isPublicRoute stays
 *    false for /api/cleanup; an unauthenticated crawler still gets redirected).
 *  - null otherwise.
 */
export function selfAuthenticatingRoute(pathname: string): 'agent-key' | 'route' | null {
  if (pathname.startsWith('/api/upload')) return 'agent-key';
  if (pathname === '/api/cleanup') return 'route';
  return null;
}

/**
 * Stamps the shared security-header baseline onto a response and returns it.
 *
 * EVERY return path in the handler below goes through this — the pass-throughs,
 * the /login redirect, the 429, and both 403s. The rejection paths are the ones
 * that matter most: they are exactly the responses an attacker sees, and they
 * used to ship bare. A response the proxy generates itself short-circuits
 * routing, so `next.config.ts`'s `headers()` never gets to decorate it; this is
 * the only thing that will.
 *
 * Both this and the static baseline read the same {@link SECURITY_HEADERS}
 * record, so the two layers cannot disagree.
 */
export function withSecurityHeaders<T extends Response>(res: T): T {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    res.headers.set(key, value);
  }
  return res;
}

export default auth(async function proxy(req) {
  const { pathname } = req.nextUrl;
  const session = req.auth;

  // ── Rate limiting ───────────────────────────────────────────────────────────
  // Method matters: POST /login is the credentials login (a server action), so
  // it is capped, while GET /login is just the form and must not be.
  const rateLimitCategory = getRateLimitCategory(pathname, req.method);
  if (rateLimitCategory) {
    const ip = getClientIp(req);
    if (isRateLimited(rateLimitCategory, ip)) {
      return withSecurityHeaders(new NextResponse(
        JSON.stringify({ error: 'Too many requests' }),
        { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } },
      ));
    }
  }

  if (isPublicRoute(pathname)) {
    return withSecurityHeaders(NextResponse.next());
  }

  // No cookie session. Before redirecting to /login, allow a self-authenticating
  // route to reach its own handler instead.
  if (!session) {
    const selfAuthKind = selfAuthenticatingRoute(pathname);

    if (selfAuthKind === 'agent-key') {
      // resolveBearerAuth (jose-only, edge-safe) verifies the aud:"upload" key;
      // admin routes are never reachable this way.
      const bearer = await resolveBearerAuth(req);
      if (bearer && (bearer.permissions.includes('upload') || bearer.permissions.includes('admin'))) {
        return withSecurityHeaders(NextResponse.next());
      }
    } else if (selfAuthKind === 'route' && req.headers.get('authorization')) {
      // /api/cleanup: let the request reach the handler, which performs its
      // own OIDC / CLEANUP_SECRET verification and returns 401 itself.
      return withSecurityHeaders(NextResponse.next());
    }

    // Not authenticated — redirect to /login with callbackUrl
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('callbackUrl', req.nextUrl.pathname);
    return withSecurityHeaders(NextResponse.redirect(loginUrl));
  }

  const permissions: string[] = session.user?.permissions ?? [];

  if (requiresAdmin(pathname)) {
    if (!permissions.includes('admin')) {
      // Authenticated but insufficient permissions
      return withSecurityHeaders(new NextResponse(
        JSON.stringify({ error: 'Forbidden', phase: 'auth' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ));
    }
  }

  if (requiresUpload(pathname)) {
    if (!permissions.includes('upload') && !permissions.includes('admin')) {
      return withSecurityHeaders(new NextResponse(
        JSON.stringify({ error: 'Forbidden', phase: 'auth' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ));
    }
  }

  return withSecurityHeaders(NextResponse.next());
});

export const config = {
  matcher: [
    /*
     * 1. EVERY /api path, unconditionally.
     *
     * The second entry's static-asset exclusion is a suffix test over the whole
     * path, not a directory test, so a request to `/api/admin/files/1.png`
     * matched `.*\.png$` and skipped the proxy entirely: no auth gate, no rate
     * limit, no security headers. Next still routed it to the `[id]` handler,
     * where `parseInt('1.png', 10)` happily produced id 1 — appending a fake
     * extension to any /api path was a complete bypass of this file.
     *
     * API routes never serve static assets, so this entry carries no
     * exclusions at all. (`@/lib/http`'s parseId closes the coercion half of
     * the same bug at the handlers.)
     */
    '/api/:path*',
    /*
     * 2. Everything else, except paths that are genuinely static:
     * - api/ (covered exhaustively by entry 1 above)
     * - _next/static (build output)
     * - _next/image (image optimization)
     * - favicon.ico and /public folder assets
     *
     * These get the header baseline from next.config.ts's headers() instead,
     * which Next checks before the filesystem.
     */
    '/((?!api/|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
