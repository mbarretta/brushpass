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

import proxy, {
  config,
  getRateLimitCategory,
  isRateLimited,
  isPublicRoute,
  selfAuthenticatingRoute,
  withSecurityHeaders,
} from '@/proxy';
import { mintAgentKey, resolveBearerAuth, AGENT_KEY_ISSUER } from '@/lib/agent-key';
import { SECURITY_HEADERS } from '@/lib/security-headers';
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
  opts: { headers?: Record<string, string>; auth?: unknown; method?: string } = {},
): NextRequest {
  const headerMap = opts.headers ?? {};
  const url = new URL(`http://localhost${pathname}`);
  const nextUrl = Object.assign(url, { clone: () => new URL(url.href) });
  return {
    nextUrl,
    auth: opts.auth,
    method: opts.method ?? 'GET',
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

  it('categorizes the anonymous group-token surfaces, which each cost a bcrypt compare', () => {
    expect(getRateLimitCategory('/api/groups/my-group/access', 'POST')).toBe('group_access');
    expect(getRateLimitCategory('/api/groups/my-group/files/abc')).toBe('group_download');
    // The access route is only a bcrypt surface on POST; a GET must not be
    // charged against the tighter interactive-unlock budget.
    expect(getRateLimitCategory('/api/groups/my-group/access', 'GET')).toBeNull();
  });

  it('categorizes the new tokenless download POST alongside the GET', () => {
    // POST /api/download/[sha256] is the browser's tokenless path and spends a
    // bcrypt compare exactly like the GET, so it must share the same cap.
    expect(getRateLimitCategory('/api/download/abc', 'POST')).toBe('download');
    expect(getRateLimitCategory('/api/download/abc', 'GET')).toBe('download');
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

describe('default-exported proxy handler: method-aware login throttling', () => {
  // The limiter now lives in @/lib/throttle and the proxy re-exports it; this
  // asserts the wiring, i.e. that the handler passes req.method through so the
  // server-action login transport (POST /login) is capped while the form page
  // (GET /login) is not.
  it('429s a POST /login flood but never throttles the GET login page', async () => {
    const clientIp = { 'x-forwarded-for': '203.0.113.7' };
    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const res = (await proxy(
        makeProxyRequest('/login', { method: 'POST', headers: clientIp, auth: null }),
        undefined as unknown as Parameters<typeof proxy>[1],
      )) as Response;
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);

    // A GET from the same client still renders the form.
    const page = (await proxy(
      makeProxyRequest('/login', { method: 'GET', headers: clientIp, auth: null }),
      undefined as unknown as Parameters<typeof proxy>[1],
    )) as Response;
    expect(page.status).not.toBe(429);
  });
});

// ---------------------------------------------------------------------------
// config.matcher
// ---------------------------------------------------------------------------

/**
 * Compiles one `config.matcher` entry to the regex Next would derive from it.
 *
 * Only the two shapes this app actually uses are understood, and an entry in
 * any other shape throws rather than silently failing to match — a test that
 * quietly stops exercising the matcher is worse than no test.
 */
function matcherToRegExp(source: string): RegExp {
  // path-to-regexp form: `:path*` is zero-or-more segments, so `/api` itself
  // and every path beneath it match.
  if (source === '/api/:path*') return /^\/api(?:\/.*)?$/;
  // Raw regular-expression form (the negative-lookahead entry).
  if (source.includes('(?!')) return new RegExp(`^${source}$`);
  throw new Error(`proxy matcher entry not understood by this test: ${source}`);
}

/** True when at least one matcher entry claims the path, as Next ORs them. */
function proxyMatches(pathname: string): boolean {
  return config.matcher.map(matcherToRegExp).some((re) => re.test(pathname));
}

describe('config.matcher', () => {
  it('gates every /api path even when it carries a fake static extension', () => {
    // The bug: the old single entry excluded `.*\.png$` across the WHOLE path,
    // so appending `.png` to any API path skipped the proxy completely — no
    // auth gate, no rate limit, no security headers — while Next still routed
    // it to the handler.
    expect(proxyMatches('/api/admin/files/1.png')).toBe(true);
    expect(proxyMatches('/api/admin/users/1.png')).toBe(true);
    expect(proxyMatches('/api/admin/files/1.jpg')).toBe(true);
    expect(proxyMatches('/api/cleanup.svg')).toBe(true);
    expect(proxyMatches('/api/upload/complete.webp')).toBe(true);
  });

  it('gates ordinary /api paths and the /api root', () => {
    expect(proxyMatches('/api')).toBe(true);
    expect(proxyMatches('/api/admin/files/1')).toBe(true);
    expect(proxyMatches('/api/download/abc')).toBe(true);
  });

  it('still gates non-API app paths', () => {
    expect(proxyMatches('/')).toBe(true);
    expect(proxyMatches('/admin')).toBe(true);
    expect(proxyMatches('/upload')).toBe(true);
    expect(proxyMatches('/login')).toBe(true);
  });

  it('still lets genuine static assets bypass the proxy', () => {
    // These get the header baseline from next.config.ts's headers() instead,
    // which Next checks before the filesystem.
    expect(proxyMatches('/brushpass-logo.png')).toBe(false);
    expect(proxyMatches('/_next/static/chunks/main.js')).toBe(false);
    expect(proxyMatches('/_next/image')).toBe(false);
    expect(proxyMatches('/favicon.ico')).toBe(false);
    expect(proxyMatches('/some/nested/asset.webp')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Security headers on every proxy return path
// ---------------------------------------------------------------------------

/** Asserts the full shared baseline is present on a proxy-generated response. */
function expectSecurityHeaders(res: Response) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    expect(res.headers.get(key), `missing header ${key}`).toBe(value);
  }
}

describe('withSecurityHeaders()', () => {
  it('stamps the whole baseline onto any response and returns the same object', () => {
    const res = new Response('body', { status: 418 });
    const returned = withSecurityHeaders(res);

    expect(returned).toBe(res);
    expect(returned.status).toBe(418);
    expectSecurityHeaders(returned);
  });

  it('overwrites a pre-set value rather than appending a second header', () => {
    // Header duplication is how a weaker policy sneaks past a stronger one.
    const res = new Response(null, { headers: { 'X-Frame-Options': 'SAMEORIGIN' } });
    withSecurityHeaders(res);
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });
});

describe('default-exported proxy handler: security headers on every return path', () => {
  it('includes a report-only CSP that still permits the direct-to-GCS upload PUT', async () => {
    const res = (await proxy(
      makeProxyRequest('/', { auth: null }),
      undefined as unknown as Parameters<typeof proxy>[1],
    )) as Response;

    const csp = res.headers.get('Content-Security-Policy-Report-Only');
    expect(csp).not.toBeNull();
    // Omitting this host would silently break every upload: the browser PUTs
    // file bytes straight to the signed GCS URL via XMLHttpRequest.
    expect(csp).toContain("connect-src 'self' https://storage.googleapis.com");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // Report-Only in this change by design; the enforcing header must not be
    // set until the nonce work lands (see src/lib/security-headers.ts).
    expect(res.headers.get('Content-Security-Policy')).toBeNull();
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=');
  });

  it('stamps them on a public pass-through', async () => {
    const res = (await proxy(
      makeProxyRequest('/', { auth: null }),
      undefined as unknown as Parameters<typeof proxy>[1],
    )) as Response;
    expectSecurityHeaders(res);
  });

  it('stamps them on the 429', async () => {
    const clientIp = { 'x-forwarded-for': '203.0.113.44' };
    let res!: Response;
    for (let i = 0; i < 11; i++) {
      res = (await proxy(
        makeProxyRequest('/login', { method: 'POST', headers: clientIp, auth: null }),
        undefined as unknown as Parameters<typeof proxy>[1],
      )) as Response;
    }
    expect(res.status).toBe(429);
    expectSecurityHeaders(res);
  });

  it('stamps them on the admin 403', async () => {
    const res = (await proxy(
      makeProxyRequest('/api/admin/users', { auth: { user: { id: '1', permissions: ['upload'] } } }),
      undefined as unknown as Parameters<typeof proxy>[1],
    )) as Response;
    expect(res.status).toBe(403);
    expectSecurityHeaders(res);
  });

  it('stamps them on the upload 403', async () => {
    const res = (await proxy(
      makeProxyRequest('/api/upload', { auth: { user: { id: '1', permissions: [] } } }),
      undefined as unknown as Parameters<typeof proxy>[1],
    )) as Response;
    expect(res.status).toBe(403);
    expectSecurityHeaders(res);
  });

  it('stamps them on the /login redirect', async () => {
    const res = (await proxy(
      makeProxyRequest('/admin', { auth: null }),
      undefined as unknown as Parameters<typeof proxy>[1],
    )) as Response;
    expect(res.status).toBe(307);
    expectSecurityHeaders(res);
  });

  it('stamps them on an authenticated pass-through', async () => {
    const res = (await proxy(
      makeProxyRequest('/api/admin/users', { auth: { user: { id: '1', permissions: ['admin'] } } }),
      undefined as unknown as Parameters<typeof proxy>[1],
    )) as Response;
    expectSecurityHeaders(res);
  });

  it('gates a fake-extension admin path rather than letting it through bare', async () => {
    // The end-to-end shape of ac1: with the matcher fixed, this request now
    // reaches the proxy at all, and the proxy rejects it WITH the headers.
    const res = (await proxy(
      makeProxyRequest('/api/admin/files/1.png', { auth: null }),
      undefined as unknown as Parameters<typeof proxy>[1],
    )) as Response;
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
    expectSecurityHeaders(res);
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
