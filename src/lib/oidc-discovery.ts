/**
 * OIDC provider endpoint discovery.
 *
 * Auth.js performs discovery internally for UI login, but the brokered device
 * grant needs the device-authorization and token endpoints (and the JWKS URI to
 * verify returned ID tokens) directly. This util fetches the provider's
 * `.well-known/openid-configuration` from AUTH_OIDC_ISSUER and caches the parsed
 * document.
 *
 * No provider endpoint URLs are hardcoded — everything is derived from the
 * issuer's discovery document so the same code works against any OIDC provider.
 */

/** Subset of the OIDC discovery document the device grant depends on. */
export interface OidcDiscoveryDocument {
  issuer: string;
  device_authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const WELL_KNOWN_PATH = '.well-known/openid-configuration';

/**
 * Per-issuer cache of resolved discovery documents. Keyed by issuer so a
 * misconfiguration change (different issuer) is not masked by a stale entry.
 * Discovery documents are effectively static for a provider, so an unbounded
 * in-process cache is appropriate here.
 */
const cache = new Map<string, OidcDiscoveryDocument>();

/** Joins an issuer base URL with the well-known path, tolerating a trailing slash. */
function wellKnownUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/${WELL_KNOWN_PATH}`;
}

/**
 * Validates that the fetched JSON carries the endpoints the device grant needs.
 * Throws with a precise message if any required field is missing/non-string.
 */
function assertDiscoveryShape(issuer: string, doc: unknown): OidcDiscoveryDocument {
  if (typeof doc !== 'object' || doc === null) {
    throw new Error(`oidc-discovery: discovery document for ${issuer} is not an object`);
  }
  const record = doc as Record<string, unknown>;
  const required = ['device_authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const;
  for (const field of required) {
    if (typeof record[field] !== 'string' || record[field] === '') {
      throw new Error(`oidc-discovery: discovery document for ${issuer} is missing "${field}"`);
    }
  }
  return {
    issuer: typeof record.issuer === 'string' ? record.issuer : issuer,
    device_authorization_endpoint: record.device_authorization_endpoint as string,
    token_endpoint: record.token_endpoint as string,
    jwks_uri: record.jwks_uri as string,
  };
}

/**
 * Fetches and caches the OIDC discovery document for the given issuer
 * (defaults to AUTH_OIDC_ISSUER).
 *
 * Subsequent calls for the same issuer return the cached document without a
 * network round-trip. Pass `{ force: true }` to bypass and refresh the cache.
 *
 * Throws if AUTH_OIDC_ISSUER is unset, the fetch fails/non-2xx, or the document
 * lacks a required endpoint.
 */
export async function getOidcDiscoveryDocument(
  options: { issuer?: string; force?: boolean } = {},
): Promise<OidcDiscoveryDocument> {
  const issuer = options.issuer ?? process.env.AUTH_OIDC_ISSUER ?? '';
  if (!issuer) {
    throw new Error('oidc-discovery: AUTH_OIDC_ISSUER is not configured');
  }

  if (!options.force) {
    const cached = cache.get(issuer);
    if (cached) return cached;
  }

  const url = wellKnownUrl(issuer);
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`oidc-discovery: fetch of ${url} failed with status ${response.status}`);
  }

  const json: unknown = await response.json();
  const doc = assertDiscoveryShape(issuer, json);
  cache.set(issuer, doc);
  return doc;
}

/** Clears the discovery cache. Intended for tests. */
export function _resetOidcDiscoveryCache(): void {
  cache.clear();
}
