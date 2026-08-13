/**
 * Unit tests for the proxy rate-limit categorization, the in-memory limiter,
 * and the agent-Bearer resolution path that the requiresUpload gate relies on.
 *
 * With next-auth mocked to a pass-through below, the default export becomes the
 * raw middleware and IS driven directly in the selfAuthenticatingRoute tests
 * (req.auth is set on the fake request where the real wrapper would decorate
 * it). We also test the pure, exported decision helpers the gate is composed
 * from — getRateLimitCategory / isRateLimited — plus an end-to-end check that a
 * real minted agent key resolves to upload permissions through resolveBearerAuth
 * (the same call the Bearer branch makes) while a wrong-audience / absent key
 * does not. Direct calls pass an undefined second context argument (unused by
 * the handler) and narrow the void|Response return, the same next-auth typing
 * quirk documented in tests/unit/permission-requests-route.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SignJWT } from 'jose';

// next-auth calls NextRequest from "next/server" at module-load time, which
// doesn't resolve in the Vitest (Node) environment. Mock next-auth so that
// `export const { auth } = NextAuth(config)` in src/auth.ts is a no-op; with
// auth() as identity, the proxy default export IS the raw handler, which lets
// the selfAuthenticatingRoute tests below drive it directly.
vi.mock('next-auth', () => ({
  default: (_config: unknown) => ({
    handlers: {},
    auth: (fn: unknown) => fn,
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));

import proxy, { getRateLimitCategory, isRateLimited, isPublicRoute, selfAuthenticatingRoute } from '@/proxy';
import { mintAgentKey, resolveBearerAuth, AGENT_KEY_ISSUER } from '@/lib/agent-key';
import type { NextRequest } from 'next/server';

const TEST_SECRET = 'test-proxy-agent-key-secret-value-1234567890';

function requestWithAuth(headerValue: string | null): { headers: { get(name: string): string | null } } {
  return {
    headers: {
      get(name: string): string | null {
        return name.toLowerCase() === 'authorization' ? headerValue : null;
      },
    },
  };
}

// Builds a minimal fake request satisfying exactly what the default-exported
// proxy handler reads: nextUrl (a real URL, so .clone()/.searchParams work for
// the /login redirect branch), .auth (what next-auth's real `auth()` wrapper
// would decorate onto the request — set directly here since next-auth is
// mocked to identity above), and .headers.get(). Cast to NextRequest for the
// handler's parameter type; the handler never touches any other member.
function makeProxyRequest(
  pathname: string,
  opts: { headers?: Record<string, string>; auth?: unknown } = {},
): NextRequest {
  const headerMap = opts.headers ?? {};
  const url = new URL(`http://localhost${pathname}`);
  const nextUrl = Object.assign(url, { clone: () => new URL(url.href) });
  return {
    nextUrl,
    auth: opts.auth,
    headers: {
      get(name: string): string | null {
        const key = Object.keys(headerMap).find((k) => k.toLowerCase() === name.toLowerCase());
        return key ? headerMap[key] : null;
      },
    },
  } as unknown as NextRequest;
}

describe('getRateLimitCategory()', () => {
  it('categorizes the existing login/download/account paths unchanged', () => {
    expect(getRateLimitCategory('/api/auth/callback/credentials')).toBe('login');
    expect(getRateLimitCategory('/api/download/abc')).toBe('download');
    expect(getRateLimitCategory('/api/account')).toBe('account');
  });

  it('categorizes the agent device-start endpoint as device_start', () => {
    expect(getRateLimitCategory('/api/agent/device/start')).toBe('device_start');
  });

  it('categorizes the agent device-token endpoint as device_token', () => {
    expect(getRateLimitCategory('/api/agent/device/token')).toBe('device_token');
  });

  it('returns null for paths with no rate-limit category', () => {
    expect(getRateLimitCategory('/api/upload')).toBeNull();
    expect(getRateLimitCategory('/')).toBeNull();
    expect(getRateLimitCategory('/api/agent/device')).toBeNull();
  });

  it('categorizes /api/cleanup as cleanup, protecting it from unauthenticated hammering', () => {
    // /api/cleanup is self-authenticating (reachable pre-session), so it must
    // carry its own rate-limit category rather than relying on cookie auth
    // having already run.
    expect(getRateLimitCategory('/api/cleanup')).toBe('cleanup');
  });
});

describe('isRateLimited()', () => {
  it('caps device_token per IP and lets a different IP through', () => {
    const ip = '10.0.0.1';
    // device_token max is 30/min; the 31st request from the same IP is limited.
    let limited = false;
    for (let i = 0; i < 31; i++) {
      limited = isRateLimited('device_token', ip);
    }
    expect(limited).toBe(true);

    // A different IP is tracked independently and is not limited.
    expect(isRateLimited('device_token', '10.0.0.2')).toBe(false);
  });

  it('caps device_start per IP after its (smaller) limit', () => {
    const ip = '10.0.1.1';
    let limited = false;
    for (let i = 0; i < 6; i++) {
      limited = isRateLimited('device_start', ip);
    }
    expect(limited).toBe(true);
  });

  it('never limits an uncategorized request', () => {
    for (let i = 0; i < 1000; i++) {
      expect(isRateLimited('not-a-category', '10.0.2.1')).toBe(false);
    }
  });

  it('caps the cleanup category per IP', () => {
    const ip = '10.0.4.1';
    let limited = false;
    for (let i = 0; i < 11; i++) {
      limited = isRateLimited('cleanup', ip);
    }
    expect(limited).toBe(true);
  });
});

describe('selfAuthenticatingRoute()', () => {
  it('routes the upload API through the agent-key check', () => {
    expect(selfAuthenticatingRoute('/api/upload')).toBe('agent-key');
    expect(selfAuthenticatingRoute('/api/upload/complete')).toBe('agent-key');
  });

  it('routes exactly /api/cleanup to its own handler check', () => {
    expect(selfAuthenticatingRoute('/api/cleanup')).toBe('route');
  });

  it('returns null for everything else, including near-miss paths', () => {
    expect(selfAuthenticatingRoute('/upload')).toBeNull();
    expect(selfAuthenticatingRoute('/admin')).toBeNull();
    expect(selfAuthenticatingRoute('/api/cleanup/extra')).toBeNull();
    expect(selfAuthenticatingRoute('/api/cleanups')).toBeNull();
  });
});

describe('default-exported proxy handler: /api/cleanup self-authentication', () => {
  // Regression coverage for ac1: selfAuthenticatingRoute() and isPublicRoute()
  // being correct is not sufficient on its own — the `if (!session)` branch in
  // the handler has to actually wire selfAuthKind === 'route' to a pass-through
  // rather than the /login redirect. Exercise the real default export (not just
  // the pure helpers above) to catch a regression in that wiring.
  it('passes an unauthenticated /api/cleanup request with an Authorization header through to the handler, without redirecting', async () => {
    const req = makeProxyRequest('/api/cleanup', {
      headers: { authorization: 'Bearer sometoken' },
      auth: null,
    });

    const res = (await proxy(req, undefined as unknown as Parameters<typeof proxy>[1])) as Response;

    expect(res.status).not.toBe(307);
    expect(res.status).not.toBe(308);
    expect(res.headers.get('location')).toBeNull();
  });

  it('still redirects an unauthenticated /api/cleanup request with NO Authorization header to /login', async () => {
    // Deny-by-default: /api/cleanup is not in isPublicRoute, so a caller with no
    // session AND no Authorization header must still be redirected, not let through.
    const req = makeProxyRequest('/api/cleanup', { auth: null });

    const res = (await proxy(req, undefined as unknown as Parameters<typeof proxy>[1])) as Response;

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });
});

describe('isPublicRoute()', () => {
  // These cases assert the gate's decision helper directly for breadth (the
  // wrapped default export is driven directly in the selfAuthenticatingRoute
  // tests above): a path that isPublicRoute() returns true for is allowed
  // through (NextResponse.next()) before the `if (!session)` block ever
  // reaches the 307 redirect to /login.
  it('treats the agent device-grant endpoints as public (no /login redirect)', () => {
    // Remediates obs1: an unauthenticated agent — the only intended caller of the
    // device grant — must reach these handlers instead of being redirected.
    expect(isPublicRoute('/api/agent/device/start')).toBe(true);
    expect(isPublicRoute('/api/agent/device/token')).toBe(true);
  });

  it('still requires auth for the upload API, the upload page, and admin routes', () => {
    // Unchanged behavior: /api/upload* stays cookie-or-Bearer, /upload is a cookie
    // page, admin routes are cookie-only — none of these are public.
    expect(isPublicRoute('/api/upload')).toBe(false);
    expect(isPublicRoute('/api/upload/complete')).toBe(false);
    expect(isPublicRoute('/upload')).toBe(false);
    expect(isPublicRoute('/admin')).toBe(false);
    expect(isPublicRoute('/api/admin/users')).toBe(false);
  });

  it('does not expose other /api/agent/* paths via a loose prefix', () => {
    // The fix matches the two exact device paths only.
    expect(isPublicRoute('/api/agent')).toBe(false);
    expect(isPublicRoute('/api/agent/device')).toBe(false);
    expect(isPublicRoute('/api/agent/device/start/extra')).toBe(false);
    expect(isPublicRoute('/api/agent/other')).toBe(false);
  });

  it('keeps the existing public routes public', () => {
    expect(isPublicRoute('/login')).toBe(true);
    expect(isPublicRoute('/')).toBe(true);
    expect(isPublicRoute('/api/auth/session')).toBe(true);
    expect(isPublicRoute('/api/download/abc')).toBe(true);
  });
});

describe('rate limiting still applies to the now-public device endpoints', () => {
  // The device endpoints are public, but the rate-limit check runs first in the
  // proxy (before isPublicRoute), so device_start/device_token still fire. These
  // assert the two pieces the gate composes for those paths.
  it('still categorizes the public device endpoints for rate limiting', () => {
    expect(getRateLimitCategory('/api/agent/device/start')).toBe('device_start');
    expect(getRateLimitCategory('/api/agent/device/token')).toBe('device_token');
  });

  it('still enforces the device_start cap on the public start endpoint', () => {
    const category = getRateLimitCategory('/api/agent/device/start')!;
    const ip = '10.0.3.1';
    let limited = false;
    for (let i = 0; i < 6; i++) {
      limited = isRateLimited(category, ip);
    }
    expect(limited).toBe(true);
  });

  it('still enforces the device_token cap on the public token endpoint', () => {
    const category = getRateLimitCategory('/api/agent/device/token')!;
    const ip = '10.0.3.2';
    let limited = false;
    for (let i = 0; i < 31; i++) {
      limited = isRateLimited(category, ip);
    }
    expect(limited).toBe(true);
  });
});

describe('Bearer resolution in the requiresUpload gate', () => {
  beforeEach(() => {
    process.env.AGENT_KEY_SECRET = TEST_SECRET;
    delete process.env.AUTH_SECRET;
    delete process.env.AGENT_KEY_TTL_SECONDS;
  });

  afterEach(() => {
    delete process.env.AGENT_KEY_SECRET;
    delete process.env.AUTH_SECRET;
    delete process.env.AGENT_KEY_TTL_SECONDS;
  });

  it('resolves a minted upload key to upload permissions (gate would allow)', async () => {
    const token = await mintAgentKey({ sub: 'u1', username: 'agent', permissions: ['upload'] });
    const bearer = await resolveBearerAuth(requestWithAuth(`Bearer ${token}`));
    expect(bearer).not.toBeNull();
    expect(bearer!.permissions.includes('upload') || bearer!.permissions.includes('admin')).toBe(true);
  });

  it('does not resolve a wrong-audience key (gate would redirect)', async () => {
    const wrongAud = await new SignJWT({ username: 'agent', permissions: ['upload'] })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('u1')
      .setAudience('not-upload')
      .setIssuer(AGENT_KEY_ISSUER)
      .setIssuedAt()
      .setExpirationTime('5m')
      .setJti('deadbeef')
      .sign(new TextEncoder().encode(TEST_SECRET));
    const bearer = await resolveBearerAuth(requestWithAuth(`Bearer ${wrongAud}`));
    expect(bearer).toBeNull();
  });

  it('does not resolve an absent Bearer header (gate would redirect)', async () => {
    const bearer = await resolveBearerAuth(requestWithAuth(null));
    expect(bearer).toBeNull();
  });
});
