/**
 * Unit tests for the agent upload-key mint/verify/Bearer-resolution util.
 *
 * Covers: mint -> verify round-trip, wrong-audience rejection, expired-token
 * rejection, and missing/garbage Bearer header handling. Tokens for the
 * negative cases are forged directly with jose using the same signing secret
 * so we exercise verifyAgentKey's audience/expiry guards rather than relying on
 * mintAgentKey (which always sets aud:"upload" and a future expiry).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SignJWT } from 'jose';
import {
  mintAgentKey,
  verifyAgentKey,
  resolveBearerAuth,
  resolveAgentKeyTtlSeconds,
  AGENT_KEY_ISSUER,
  AGENT_KEY_AUDIENCE,
  DEFAULT_AGENT_KEY_TTL_SECONDS,
  MAX_AGENT_KEY_TTL_SECONDS,
  MIN_AGENT_KEY_TTL_SECONDS,
} from '@/lib/agent-key';
import type { Permission } from '@/types';

const TEST_SECRET = 'test-agent-key-secret-value-1234567890';

function key(): Uint8Array {
  return new TextEncoder().encode(TEST_SECRET);
}

/** Builds a request-like object carrying an Authorization header value. */
function requestWithAuth(headerValue: string | null): { headers: { get(name: string): string | null } } {
  return {
    headers: {
      get(name: string): string | null {
        return name.toLowerCase() === 'authorization' ? headerValue : null;
      },
    },
  };
}

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

describe('resolveAgentKeyTtlSeconds()', () => {
  it('defaults to DEFAULT_AGENT_KEY_TTL_SECONDS when unset', () => {
    expect(resolveAgentKeyTtlSeconds()).toBe(DEFAULT_AGENT_KEY_TTL_SECONDS);
  });

  it('clamps an over-large TTL to the maximum', () => {
    process.env.AGENT_KEY_TTL_SECONDS = String(MAX_AGENT_KEY_TTL_SECONDS * 100);
    expect(resolveAgentKeyTtlSeconds()).toBe(MAX_AGENT_KEY_TTL_SECONDS);
  });

  it('clamps a too-small TTL up to the minimum', () => {
    process.env.AGENT_KEY_TTL_SECONDS = '1';
    expect(resolveAgentKeyTtlSeconds()).toBe(MIN_AGENT_KEY_TTL_SECONDS);
  });

  it('falls back to the default on non-numeric input', () => {
    process.env.AGENT_KEY_TTL_SECONDS = 'not-a-number';
    expect(resolveAgentKeyTtlSeconds()).toBe(DEFAULT_AGENT_KEY_TTL_SECONDS);
  });
});

describe('mintAgentKey() -> verifyAgentKey() round-trip', () => {
  it('mints a key whose verified claims match the input', async () => {
    const permissions: Permission[] = ['upload', 'admin'];
    const token = await mintAgentKey({ sub: '42', username: 'alice@chainguard.dev', permissions });

    const claims = await verifyAgentKey(token);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe('42');
    expect(claims!.username).toBe('alice@chainguard.dev');
    expect(claims!.permissions).toEqual(permissions);
    expect(claims!.aud).toBe(AGENT_KEY_AUDIENCE);
    expect(claims!.iss).toBe(AGENT_KEY_ISSUER);
    expect(typeof claims!.iat).toBe('number');
    expect(typeof claims!.exp).toBe('number');
    expect(claims!.exp).toBeGreaterThan(claims!.iat);
    expect(claims!.jti).toMatch(/^[0-9a-f]{32}$/);
  });

  it('honors AGENT_KEY_TTL_SECONDS for the exp claim', async () => {
    process.env.AGENT_KEY_TTL_SECONDS = '300';
    const token = await mintAgentKey({ sub: '1', username: 'bob', permissions: [] });
    const claims = await verifyAgentKey(token);
    expect(claims).not.toBeNull();
    expect(claims!.exp - claims!.iat).toBe(300);
  });

  it('falls back to AUTH_SECRET when AGENT_KEY_SECRET is unset', async () => {
    delete process.env.AGENT_KEY_SECRET;
    process.env.AUTH_SECRET = TEST_SECRET;
    const token = await mintAgentKey({ sub: '7', username: 'carol', permissions: ['upload'] });
    const claims = await verifyAgentKey(token);
    expect(claims).not.toBeNull();
    expect(claims!.username).toBe('carol');
  });

  it('produces a unique jti per mint', async () => {
    const a = await verifyAgentKey(await mintAgentKey({ sub: '1', username: 'a', permissions: [] }));
    const b = await verifyAgentKey(await mintAgentKey({ sub: '1', username: 'a', permissions: [] }));
    expect(a!.jti).not.toBe(b!.jti);
  });
});

describe('verifyAgentKey() rejections', () => {
  it('rejects a token whose audience is not "upload"', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ username: 'mallory', permissions: ['upload'] })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('99')
      .setAudience('download')
      .setIssuer(AGENT_KEY_ISSUER)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .setJti('abc')
      .sign(key());

    expect(await verifyAgentKey(token)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = await new SignJWT({ username: 'eve', permissions: ['upload'] })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('5')
      .setAudience(AGENT_KEY_AUDIENCE)
      .setIssuer(AGENT_KEY_ISSUER)
      .setIssuedAt(past - 300)
      .setExpirationTime(past)
      .setJti('def')
      .sign(key());

    expect(await verifyAgentKey(token)).toBeNull();
  });

  it('rejects a token signed with the wrong secret', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ username: 'eve', permissions: ['upload'] })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('5')
      .setAudience(AGENT_KEY_AUDIENCE)
      .setIssuer(AGENT_KEY_ISSUER)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .setJti('ghi')
      .sign(new TextEncoder().encode('a-completely-different-secret-value'));

    expect(await verifyAgentKey(token)).toBeNull();
  });

  it('rejects a token with the wrong issuer', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ username: 'eve', permissions: ['upload'] })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('5')
      .setAudience(AGENT_KEY_AUDIENCE)
      .setIssuer('not-brushpass')
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .setJti('jkl')
      .sign(key());

    expect(await verifyAgentKey(token)).toBeNull();
  });

  it('returns null for an empty or garbage token string', async () => {
    expect(await verifyAgentKey('')).toBeNull();
    expect(await verifyAgentKey('not.a.jwt')).toBeNull();
  });

  it('returns null (does not throw) when no signing secret is configured', async () => {
    // Mint while a secret is present, then drop it before verifying so a
    // misconfigured edge proxy denies rather than 500-ing every request.
    const token = await mintAgentKey({ sub: '1', username: 'a', permissions: ['upload'] });
    delete process.env.AGENT_KEY_SECRET;
    delete process.env.AUTH_SECRET;
    await expect(verifyAgentKey(token)).resolves.toBeNull();
  });
});

describe('resolveBearerAuth()', () => {
  it('resolves { username, permissions } from a valid Bearer header', async () => {
    const token = await mintAgentKey({ sub: '42', username: 'alice', permissions: ['upload'] });
    const result = await resolveBearerAuth(requestWithAuth(`Bearer ${token}`));
    expect(result).toEqual({ username: 'alice', permissions: ['upload'] });
  });

  it('is case-insensitive in the Bearer scheme', async () => {
    const token = await mintAgentKey({ sub: '42', username: 'alice', permissions: ['upload'] });
    const result = await resolveBearerAuth(requestWithAuth(`bearer ${token}`));
    expect(result).toEqual({ username: 'alice', permissions: ['upload'] });
  });

  it('returns null when the Authorization header is missing', async () => {
    expect(await resolveBearerAuth(requestWithAuth(null))).toBeNull();
  });

  it('returns null for a non-Bearer scheme', async () => {
    expect(await resolveBearerAuth(requestWithAuth('Basic dXNlcjpwYXNz'))).toBeNull();
  });

  it('returns null for a Bearer header with a garbage token', async () => {
    expect(await resolveBearerAuth(requestWithAuth('Bearer not-a-real-token'))).toBeNull();
  });

  it('returns null for a Bearer header with no token value', async () => {
    expect(await resolveBearerAuth(requestWithAuth('Bearer'))).toBeNull();
    expect(await resolveBearerAuth(requestWithAuth('Bearer    '))).toBeNull();
  });

  it('returns null for a wrong-audience token presented as Bearer', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ username: 'mallory', permissions: ['admin'] })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('99')
      .setAudience('download')
      .setIssuer(AGENT_KEY_ISSUER)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .setJti('mno')
      .sign(key());

    expect(await resolveBearerAuth(requestWithAuth(`Bearer ${token}`))).toBeNull();
  });
});
