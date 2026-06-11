/**
 * Route-handler unit tests for POST /api/agent/device/token (poll + mint).
 *
 * The RFC 8628 token exchange is fully mocked: the Google token endpoint is
 * stubbed via global.fetch, the discovered endpoints + JWKS via @/lib/oidc-discovery
 * and jose, the server-side session store via @/lib/db, permission resolution
 * via @/auth, and key minting via @/lib/agent-key. We assert the polling-status
 * mapping (pending / slow_down / denied / expired) and a successful mint, plus
 * that the api_key is never returned without a verified ID token.
 */

import crypto from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Module mocks — hoisted by Vitest before any imports ─────────────────────

vi.mock('@/lib/db', () => ({
  getDeviceSessionByPollTokenHash: vi.fn(),
  updateDeviceSessionInterval: vi.fn(),
  deleteDeviceSession: vi.fn(),
}));

vi.mock('@/lib/oidc-discovery', () => ({
  getOidcDiscoveryDocument: vi.fn(),
}));

vi.mock('@/auth', () => ({
  resolveOidcUserPermissions: vi.fn(),
}));

vi.mock('@/lib/agent-key', () => ({
  mintAgentKey: vi.fn(),
  resolveAgentKeyTtlSeconds: vi.fn(() => 900),
}));

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => 'jwks-key-set'),
  jwtVerify: vi.fn(),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

const POLL_TOKEN = 'poll-token-opaque-value-abcdef';
const POLL_TOKEN_HASH = crypto.createHash('sha256').update(POLL_TOKEN).digest('hex');

const DISCOVERY = {
  issuer: 'https://accounts.example.com',
  device_authorization_endpoint: 'https://accounts.example.com/device',
  token_endpoint: 'https://accounts.example.com/token',
  jwks_uri: 'https://accounts.example.com/jwks',
};

function makeSession(overrides: Partial<{
  poll_token_hash: string;
  device_code: string;
  interval: number;
  expires_at: number;
  created_at: number;
}> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    poll_token_hash: POLL_TOKEN_HASH,
    device_code: 'GOOGLE_DEVICE_CODE',
    interval: 5,
    expires_at: now + 600,
    created_at: now,
    ...overrides,
  };
}

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/agent/device/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Stub global.fetch to return a single Google token-endpoint response. */
function stubTokenEndpoint(status: number, json: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
    }),
  );
}

async function importRoute() {
  return import('@/app/api/agent/device/token/route');
}

async function setSessionMock(session: ReturnType<typeof makeSession> | undefined) {
  const db = await import('@/lib/db');
  vi.mocked(db.getDeviceSessionByPollTokenHash).mockReturnValue(session);
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  // Reset module registry so the route's in-memory per-session poll throttle
  // (lastPolledAt) starts empty for each test; otherwise a prior test's poll
  // would make the next one look "too soon" and short-circuit to slow_down.
  vi.resetModules();
  process.env.AGENT_OIDC_CLIENT_ID = 'agent-client-id';
  process.env.AGENT_OIDC_CLIENT_SECRET = 'agent-client-secret';
  delete process.env.AUTH_OIDC_ADMIN_DOMAIN;

  const discovery = await import('@/lib/oidc-discovery');
  vi.mocked(discovery.getOidcDiscoveryDocument).mockResolvedValue(DISCOVERY);

  const agentKey = await import('@/lib/agent-key');
  vi.mocked(agentKey.resolveAgentKeyTtlSeconds).mockReturnValue(900);
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('POST /api/agent/device/token', () => {
  it('returns 400 when poll_token is missing', async () => {
    const { POST } = await importRoute();
    const res = await POST(makeRequest({}) as never);
    expect(res.status).toBe(400);
  });

  it('returns 400 {status:expired} for an unknown session', async () => {
    await setSessionMock(undefined);
    const { POST } = await importRoute();
    const res = await POST(makeRequest({ poll_token: POLL_TOKEN }) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 'expired' });
  });

  it('maps authorization_pending → 202 {status:pending}', async () => {
    await setSessionMock(makeSession());
    stubTokenEndpoint(400, { error: 'authorization_pending' });

    const { POST } = await importRoute();
    const res = await POST(makeRequest({ poll_token: POLL_TOKEN }) as never);

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: 'pending' });
    // Session must NOT be dropped while still pending.
    const db = await import('@/lib/db');
    expect(vi.mocked(db.deleteDeviceSession)).not.toHaveBeenCalled();
  });

  it('maps slow_down → 202 {status:slow_down, interval} and bumps the stored interval', async () => {
    await setSessionMock(makeSession({ interval: 5 }));
    stubTokenEndpoint(400, { error: 'slow_down' });

    const { POST } = await importRoute();
    const res = await POST(makeRequest({ poll_token: POLL_TOKEN }) as never);

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.status).toBe('slow_down');
    expect(json.interval).toBe(10);

    const db = await import('@/lib/db');
    expect(vi.mocked(db.updateDeviceSessionInterval)).toHaveBeenCalledWith(POLL_TOKEN_HASH, 10);
    expect(vi.mocked(db.deleteDeviceSession)).not.toHaveBeenCalled();
  });

  it('maps access_denied → 403 {status:denied} and drops the session', async () => {
    await setSessionMock(makeSession());
    stubTokenEndpoint(400, { error: 'access_denied' });

    const { POST } = await importRoute();
    const res = await POST(makeRequest({ poll_token: POLL_TOKEN }) as never);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ status: 'denied' });

    const db = await import('@/lib/db');
    expect(vi.mocked(db.deleteDeviceSession)).toHaveBeenCalledWith(POLL_TOKEN_HASH);
  });

  it('maps expired_token → 400 {status:expired} and drops the session', async () => {
    await setSessionMock(makeSession());
    stubTokenEndpoint(400, { error: 'expired_token' });

    const { POST } = await importRoute();
    const res = await POST(makeRequest({ poll_token: POLL_TOKEN }) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 'expired' });

    const db = await import('@/lib/db');
    expect(vi.mocked(db.deleteDeviceSession)).toHaveBeenCalledWith(POLL_TOKEN_HASH);
  });

  it('drops the session and returns 400 when its own expiry has passed', async () => {
    const now = Math.floor(Date.now() / 1000);
    await setSessionMock(makeSession({ expires_at: now - 10 }));

    const { POST } = await importRoute();
    const res = await POST(makeRequest({ poll_token: POLL_TOKEN }) as never);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 'expired' });

    const db = await import('@/lib/db');
    expect(vi.mocked(db.deleteDeviceSession)).toHaveBeenCalledWith(POLL_TOKEN_HASH);
    // Should not have reached the mint path for an already-expired session.
    const agentKey = await import('@/lib/agent-key');
    expect(vi.mocked(agentKey.mintAgentKey)).not.toHaveBeenCalled();
  });

  it('on success verifies the ID token, mints the key, returns it, and drops the session', async () => {
    await setSessionMock(makeSession());
    stubTokenEndpoint(200, { id_token: 'GOOGLE_ID_TOKEN', token_type: 'Bearer' });

    const jose = await import('jose');
    vi.mocked(jose.jwtVerify).mockResolvedValue({
      payload: { email: 'agent@chainguard.dev', name: 'Agent' },
    } as never);

    const auth = await import('@/auth');
    vi.mocked(auth.resolveOidcUserPermissions).mockResolvedValue({
      id: 7,
      email: 'agent@chainguard.dev',
      permissions: ['upload', 'admin'],
    });

    const fakeKey = 'minted.agent.key';
    const agentKey = await import('@/lib/agent-key');
    vi.mocked(agentKey.mintAgentKey).mockResolvedValue(fakeKey);

    const before = Math.floor(Date.now() / 1000);
    const { POST } = await importRoute();
    const res = await POST(makeRequest({ poll_token: POLL_TOKEN }) as never);
    const after = Math.floor(Date.now() / 1000);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.api_key).toBe(fakeKey);
    expect(json.token_type).toBe('Bearer');
    // expires_at mirrors now + the default 900s TTL (no AGENT_KEY_TTL_SECONDS set).
    expect(json.expires_at).toBeGreaterThanOrEqual(before + 900);
    expect(json.expires_at).toBeLessThanOrEqual(after + 900);
    expect(json.permissions).toEqual(['upload', 'admin']);

    // ID token was verified with issuer + the agent client id as audience.
    expect(vi.mocked(jose.jwtVerify)).toHaveBeenCalledWith(
      'GOOGLE_ID_TOKEN',
      'jwks-key-set',
      expect.objectContaining({ issuer: DISCOVERY.issuer, audience: 'agent-client-id' }),
    );
    // Minted with the resolved identity/permissions.
    expect(vi.mocked(agentKey.mintAgentKey)).toHaveBeenCalledWith({
      sub: '7',
      username: 'agent@chainguard.dev',
      permissions: ['upload', 'admin'],
    });
    // Single-use: session dropped after mint.
    const db = await import('@/lib/db');
    expect(vi.mocked(db.deleteDeviceSession)).toHaveBeenCalledWith(POLL_TOKEN_HASH);
  });

  it('rejects with 403 and drops the session when the ID token fails verification', async () => {
    await setSessionMock(makeSession());
    stubTokenEndpoint(200, { id_token: 'BAD_ID_TOKEN', token_type: 'Bearer' });

    const jose = await import('jose');
    vi.mocked(jose.jwtVerify).mockRejectedValue(new Error('signature verification failed'));

    const { POST } = await importRoute();
    const res = await POST(makeRequest({ poll_token: POLL_TOKEN }) as never);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ status: 'error', error: 'id_token_invalid' });

    const agentKey = await import('@/lib/agent-key');
    expect(vi.mocked(agentKey.mintAgentKey)).not.toHaveBeenCalled();
    const db = await import('@/lib/db');
    expect(vi.mocked(db.deleteDeviceSession)).toHaveBeenCalledWith(POLL_TOKEN_HASH);
  });

  it('rejects with 403 when the verified email domain does not match AUTH_OIDC_ADMIN_DOMAIN', async () => {
    process.env.AUTH_OIDC_ADMIN_DOMAIN = 'chainguard.dev';
    await setSessionMock(makeSession());
    stubTokenEndpoint(200, { id_token: 'GOOGLE_ID_TOKEN', token_type: 'Bearer' });

    const jose = await import('jose');
    vi.mocked(jose.jwtVerify).mockResolvedValue({
      payload: { email: 'intruder@evil.example', name: 'Intruder' },
    } as never);

    const { POST } = await importRoute();
    const res = await POST(makeRequest({ poll_token: POLL_TOKEN }) as never);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ status: 'denied' });

    const agentKey = await import('@/lib/agent-key');
    expect(vi.mocked(agentKey.mintAgentKey)).not.toHaveBeenCalled();
  });
});
