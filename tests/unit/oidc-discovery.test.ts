/**
 * Unit tests for OIDC discovery-document fetching, parsing, and caching.
 *
 * `fetch` is stubbed globally; no network access occurs. Covers a successful
 * parse of the device-grant endpoints, in-process caching (one fetch per
 * issuer), forced refresh, and error paths (missing issuer, non-2xx, missing
 * required endpoint).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getOidcDiscoveryDocument, _resetOidcDiscoveryCache } from '@/lib/oidc-discovery';

const ISSUER = 'https://accounts.example.com';

const FULL_DOC = {
  issuer: ISSUER,
  device_authorization_endpoint: 'https://oauth.example.com/device/code',
  token_endpoint: 'https://oauth.example.com/token',
  jwks_uri: 'https://www.example.com/oauth2/v3/certs',
  authorization_endpoint: 'https://accounts.example.com/o/oauth2/v2/auth',
};

function mockFetchOnceJson(body: unknown, ok = true, status = 200): void {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  _resetOidcDiscoveryCache();
  process.env.AUTH_OIDC_ISSUER = ISSUER;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  _resetOidcDiscoveryCache();
  delete process.env.AUTH_OIDC_ISSUER;
});

describe('getOidcDiscoveryDocument()', () => {
  it('fetches the well-known path and returns the device-grant endpoints', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => FULL_DOC });
    vi.stubGlobal('fetch', fetchMock);

    const doc = await getOidcDiscoveryDocument();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${ISSUER}/.well-known/openid-configuration`);
    expect(doc.device_authorization_endpoint).toBe(FULL_DOC.device_authorization_endpoint);
    expect(doc.token_endpoint).toBe(FULL_DOC.token_endpoint);
    expect(doc.jwks_uri).toBe(FULL_DOC.jwks_uri);
    expect(doc.issuer).toBe(ISSUER);
  });

  it('handles an issuer with a trailing slash without doubling it', async () => {
    process.env.AUTH_OIDC_ISSUER = `${ISSUER}/`;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => FULL_DOC });
    vi.stubGlobal('fetch', fetchMock);

    await getOidcDiscoveryDocument();
    expect(fetchMock.mock.calls[0][0]).toBe(`${ISSUER}/.well-known/openid-configuration`);
  });

  it('caches the document so a second call does not refetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => FULL_DOC });
    vi.stubGlobal('fetch', fetchMock);

    await getOidcDiscoveryDocument();
    await getOidcDiscoveryDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches when force: true is passed', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => FULL_DOC });
    vi.stubGlobal('fetch', fetchMock);

    await getOidcDiscoveryDocument();
    await getOidcDiscoveryDocument({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('accepts an explicit issuer override', async () => {
    const other = 'https://other.example.org';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => FULL_DOC });
    vi.stubGlobal('fetch', fetchMock);

    await getOidcDiscoveryDocument({ issuer: other });
    expect(fetchMock.mock.calls[0][0]).toBe(`${other}/.well-known/openid-configuration`);
  });

  it('throws when AUTH_OIDC_ISSUER is not configured', async () => {
    delete process.env.AUTH_OIDC_ISSUER;
    await expect(getOidcDiscoveryDocument()).rejects.toThrow(/AUTH_OIDC_ISSUER/);
  });

  it('throws on a non-2xx response', async () => {
    mockFetchOnceJson({}, false, 500);
    await expect(getOidcDiscoveryDocument()).rejects.toThrow(/status 500/);
  });

  it('throws when a required endpoint is missing from the document', async () => {
    const incomplete = { ...FULL_DOC } as Record<string, unknown>;
    delete incomplete.device_authorization_endpoint;
    mockFetchOnceJson(incomplete);
    await expect(getOidcDiscoveryDocument()).rejects.toThrow(/device_authorization_endpoint/);
  });

  it('does not cache a failed fetch', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => FULL_DOC });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getOidcDiscoveryDocument()).rejects.toThrow();
    const doc = await getOidcDiscoveryDocument();
    expect(doc.token_endpoint).toBe(FULL_DOC.token_endpoint);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
