import { auth } from '@/auth';
import { resolveBearerAuth } from '@/lib/agent-key';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Simple in-memory sliding window. Safe for Cloud Run single-instance deployment.
// Keyed by "route-category:ip". Entries expire after the window elapses.

interface RateLimitEntry { count: number; windowStart: number }
const rateLimitStore = new Map<string, RateLimitEntry>();

const RATE_LIMITS: Record<string, { max: number; windowMs: number }> = {
  login:        { max: 10, windowMs: 60_000 },
  download:     { max: 30, windowMs: 60_000 },
  account:      { max:  3, windowMs: 60_000 },
  // /api/cleanup is self-authenticating (see selfAuthenticatingRoute below)
  // and therefore reachable by an unauthenticated caller; cap it so hammering
  // it cannot drive verifyOidcToken's outbound fetch to Google's certs.
  cleanup:      { max: 10, windowMs: 60_000 },
  // Agent device-grant endpoints. device_start opens a new device session;
  // device_token is the agent's polling loop, capped per IP here while the
  // token route additionally enforces the per-poll_token advertised interval.
  device_start: { max:  5, windowMs: 60_000 },
  device_token: { max: 30, windowMs: 60_000 },
};

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  );
}

export function isRateLimited(category: string, ip: string): boolean {
  const limit = RATE_LIMITS[category];
  if (!limit) return false;

  const key = `${category}:${ip}`;
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry || now - entry.windowStart > limit.windowMs) {
    rateLimitStore.set(key, { count: 1, windowStart: now });
    return false;
  }

  entry.count++;
  if (entry.count > limit.max) return true;
  return false;
}

export function getRateLimitCategory(pathname: string): string | null {
  if (pathname === '/api/auth/callback/credentials') return 'login';
  if (pathname.startsWith('/api/download/')) return 'download';
  if (pathname === '/api/account') return 'account';
  if (pathname === '/api/cleanup') return 'cleanup';
  if (pathname === '/api/agent/device/start') return 'device_start';
  if (pathname === '/api/agent/device/token') return 'device_token';
  return null;
}

// Periodically clear stale entries to prevent unbounded memory growth.
// Runs every 5 minutes; safe because Cloud Run is single-instance.
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    const maxWindow = Math.max(...Object.values(RATE_LIMITS).map((l) => l.windowMs));
    for (const [key, entry] of rateLimitStore) {
      if (now - entry.windowStart > maxWindow) rateLimitStore.delete(key);
    }
  }, 5 * 60_000);
}

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

export default auth(async function proxy(req) {
  const { pathname } = req.nextUrl;
  const session = req.auth;

  // ── Rate limiting ───────────────────────────────────────────────────────────
  const rateLimitCategory = getRateLimitCategory(pathname);
  if (rateLimitCategory) {
    const ip = getClientIp(req);
    if (isRateLimited(rateLimitCategory, ip)) {
      return new NextResponse(
        JSON.stringify({ error: 'Too many requests' }),
        { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } },
      );
    }
  }

  // ── Security headers ────────────────────────────────────────────────────────
  const securityHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };

  if (isPublicRoute(pathname)) {
    const res = NextResponse.next();
    Object.entries(securityHeaders).forEach(([k, v]) => res.headers.set(k, v));
    return res;
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
        const res = NextResponse.next();
        Object.entries(securityHeaders).forEach(([k, v]) => res.headers.set(k, v));
        return res;
      }
    } else if (selfAuthKind === 'route' && req.headers.get('authorization')) {
      // /api/cleanup: let the request reach the handler, which performs its
      // own OIDC / CLEANUP_SECRET verification and returns 401 itself.
      const res = NextResponse.next();
      Object.entries(securityHeaders).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }

    // Not authenticated — redirect to /login with callbackUrl
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('callbackUrl', req.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  const permissions: string[] = session.user?.permissions ?? [];

  if (requiresAdmin(pathname)) {
    if (!permissions.includes('admin')) {
      // Authenticated but insufficient permissions
      return new NextResponse(
        JSON.stringify({ error: 'Forbidden', phase: 'auth' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  if (requiresUpload(pathname)) {
    if (!permissions.includes('upload') && !permissions.includes('admin')) {
      return new NextResponse(
        JSON.stringify({ error: 'Forbidden', phase: 'auth' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  const res = NextResponse.next();
  Object.entries(securityHeaders).forEach(([k, v]) => res.headers.set(k, v));
  return res;
});

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     * - public folder assets
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
