/**
 * Unit tests for the proxy rate-limit categorization, the in-memory limiter,
 * and the agent-Bearer resolution path that the requiresUpload gate relies on.
 *
 * The full `auth()`-wrapped default export depends on next-auth's request
 * decoration (it sets `req.auth` from the session cookie) and the Edge proxy
 * harness, so it is not exercised directly here. Instead we test the pure,
 * exported decision helpers the gate is composed from — getRateLimitCategory /
 * isRateLimited — plus an end-to-end check that a real minted agent key
 * resolves to upload permissions through resolveBearerAuth (the same call the
 * Bearer branch makes) while a wrong-audience / absent key does not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SignJWT } from 'jose';

// next-auth calls NextRequest from "next/server" at module-load time, which
// doesn't resolve in the Vitest (Node) environment. Mock next-auth so that
// `export const { auth } = NextAuth(config)` in src/auth.ts is a no-op; the
// proxy default export wraps that auth(), but we test only the pure exported
// helpers (getRateLimitCategory / isRateLimited), not the wrapped handler.
vi.mock('next-auth', () => ({
  default: (_config: unknown) => ({
    handlers: {},
    auth: (fn: unknown) => fn,
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));

import { getRateLimitCategory, isRateLimited, isPublicRoute } from '@/proxy';
import { mintAgentKey, resolveBearerAuth, AGENT_KEY_ISSUER } from '@/lib/agent-key';

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
});

describe('isPublicRoute()', () => {
  // The full auth()-wrapped default export can't be driven in the Node test env
  // (see file header), so we assert the gate's decision helper directly: a path
  // that isPublicRoute() returns true for is allowed through (NextResponse.next())
  // before the `if (!session)` block ever reaches the 307 redirect to /login.
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
