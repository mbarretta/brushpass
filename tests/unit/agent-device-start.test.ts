/**
 * Route-handler unit tests for POST /api/agent/device/start.
 *
 * The handler is tested in isolation: the OIDC discovery util and the device-
 * session db helpers are mocked, and the provider's device-authorization
 * endpoint is mocked at `fetch`. Vitest module isolation ensures mocks are
 * applied before the route module is imported.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — hoisted by Vitest before any imports
// ---------------------------------------------------------------------------

vi.mock('@/lib/oidc-discovery', () => ({
  getOidcDiscoveryDocument: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  createDeviceSession: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEVICE_ENDPOINT = 'https://oauth2.example.test/device/code';
const TOKEN_ENDPOINT = 'https://oauth2.example.test/token';
const JWKS_URI = 'https://oauth2.example.test/certs';

const DEVICE_CODE = 'super-secret-device-code-value';

const deviceResponseBody = {
  device_code: DEVICE_CODE,
  user_code: 'WDJB-MJHT',
  verification_uri: 'https://www.example.test/device',
  verification_uri_complete: 'https://www.example.test/device?user_code=WDJB-MJHT',
  expires_in: 1800,
  interval: 5,
};

function mockFetchOk(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('POST /api/agent/device/start', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    process.env.AGENT_OIDC_CLIENT_ID = 'agent-client-id.apps.example.test';
    vi.mocked((await import('@/lib/oidc-discovery')).getOidcDiscoveryDocument).mockResolvedValue({
      issuer: 'https://oauth2.example.test',
      device_authorization_endpoint: DEVICE_ENDPOINT,
      token_endpoint: TOKEN_ENDPOINT,
      jwks_uri: JWKS_URI,
    });
    vi.mocked((await import('@/lib/db')).createDeviceSession).mockImplementation((data) => ({
      ...data,
      created_at: 1_700_000_000,
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AGENT_OIDC_CLIENT_ID;
  });

  it('calls the discovered device endpoint with the agent client_id and openid scope', async () => {
    const fetchMock = mockFetchOk(deviceResponseBody);

    const { POST } = await import('@/app/api/agent/device/start/route');
    await POST();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(DEVICE_ENDPOINT);
    expect(init.method).toBe('POST');
    const params = new URLSearchParams(init.body as URLSearchParams);
    expect(params.get('client_id')).toBe('agent-client-id.apps.example.test');
    expect(params.get('scope')).toBe('openid email profile');
  });

  it('stores device_code/interval/expires_at keyed by a hashed poll_token (raw poll_token never stored)', async () => {
    mockFetchOk(deviceResponseBody);

    const { POST } = await import('@/app/api/agent/device/start/route');
    const res = await POST();
    const json = await res.json();

    const { createDeviceSession } = await import('@/lib/db');
    expect(createDeviceSession).toHaveBeenCalledTimes(1);
    const stored = vi.mocked(createDeviceSession).mock.calls[0][0];

    expect(stored.device_code).toBe(DEVICE_CODE);
    expect(stored.interval).toBe(5);
    expect(typeof stored.expires_at).toBe('number');

    // The stored key is a SHA-256 hash (64 hex chars) of the returned poll_token,
    // never the raw poll_token itself.
    expect(stored.poll_token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.poll_token_hash).not.toBe(json.poll_token);
  });

  it('returns the user-facing fields plus an opaque poll_token and never the device_code', async () => {
    mockFetchOk(deviceResponseBody);

    const { POST } = await import('@/app/api/agent/device/start/route');
    const res = await POST();

    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json).toMatchObject({
      verification_uri: deviceResponseBody.verification_uri,
      verification_uri_complete: deviceResponseBody.verification_uri_complete,
      user_code: deviceResponseBody.user_code,
      interval: 5,
      expires_in: 1800,
    });
    expect(typeof json.poll_token).toBe('string');
    expect(json.poll_token.length).toBeGreaterThan(0);

    // The confidential device_code must not leak into the response.
    expect(json).not.toHaveProperty('device_code');
    expect(JSON.stringify(json)).not.toContain(DEVICE_CODE);
  });

  it('defaults the polling interval to 5s when the provider omits it', async () => {
    const withoutInterval = { ...deviceResponseBody };
    delete (withoutInterval as { interval?: number }).interval;
    mockFetchOk(withoutInterval);

    const { POST } = await import('@/app/api/agent/device/start/route');
    const res = await POST();
    const json = await res.json();

    expect(json.interval).toBe(5);
    const { createDeviceSession } = await import('@/lib/db');
    expect(vi.mocked(createDeviceSession).mock.calls[0][0].interval).toBe(5);
  });

  it('accepts the verification_url alias when verification_uri is absent', async () => {
    const rest = { ...deviceResponseBody };
    delete (rest as { verification_uri?: string }).verification_uri;
    mockFetchOk({ ...rest, verification_url: 'https://www.example.test/device-alias' });

    const { POST } = await import('@/app/api/agent/device/start/route');
    const res = await POST();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.verification_uri).toBe('https://www.example.test/device-alias');
  });

  it('returns 503 when AGENT_OIDC_CLIENT_ID is unset and never calls the provider', async () => {
    delete process.env.AGENT_OIDC_CLIENT_ID;
    const fetchMock = mockFetchOk(deviceResponseBody);

    const { POST } = await import('@/app/api/agent/device/start/route');
    const res = await POST();

    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    const { createDeviceSession } = await import('@/lib/db');
    expect(createDeviceSession).not.toHaveBeenCalled();
  });

  it('returns 502 when the provider responds non-2xx and stores nothing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const { POST } = await import('@/app/api/agent/device/start/route');
    const res = await POST();

    expect(res.status).toBe(502);
    const { createDeviceSession } = await import('@/lib/db');
    expect(createDeviceSession).not.toHaveBeenCalled();
  });

  it('returns 502 when the provider response is missing required fields', async () => {
    mockFetchOk({ user_code: 'WDJB-MJHT', expires_in: 1800 }); // no device_code/verification_uri

    const { POST } = await import('@/app/api/agent/device/start/route');
    const res = await POST();

    expect(res.status).toBe(502);
    const { createDeviceSession } = await import('@/lib/db');
    expect(createDeviceSession).not.toHaveBeenCalled();
  });
});
