/**
 * Agent upload-key minting and verification.
 *
 * Produces and verifies short-lived, audience-scoped JWTs (aud: "upload") that
 * let an autonomous agent drive the upload API without holding a cookie session
 * or the confidential OIDC client secret. This module is the single source of
 * truth for signing, audience scoping, and Bearer resolution.
 *
 * Implementation is jose-only (Web Crypto under the hood) so both mint/verify
 * and {@link resolveBearerAuth} run unchanged in the Edge proxy runtime — no
 * node-only crypto APIs are used.
 *
 * Security: the minted key, the signing secret, and the underlying token are
 * never logged from this module.
 */
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import type { Permission } from '@/types';

/** Fixed issuer stamped into every minted key and required at verification. */
export const AGENT_KEY_ISSUER = 'brushpass';

/** Fixed audience; verification rejects any token whose `aud` is not this. */
export const AGENT_KEY_AUDIENCE = 'upload';

/** Default key lifetime when AGENT_KEY_TTL_SECONDS is unset (15 minutes). */
export const DEFAULT_AGENT_KEY_TTL_SECONDS = 900;

/** Upper bound on key lifetime; AGENT_KEY_TTL_SECONDS is clamped to this (15 minutes). */
export const MAX_AGENT_KEY_TTL_SECONDS = 900;

/** Lower bound on key lifetime; protects against a 0/negative TTL minting an already-expired key. */
export const MIN_AGENT_KEY_TTL_SECONDS = 60;

/**
 * Caller-supplied identity for a minted key. Audience, issuer, and the JWT
 * timestamp/id claims (iat/exp/jti) are set by {@link mintAgentKey} and must
 * not be passed in.
 */
export interface AgentKeyClaims {
  /** Stable subject identifier (e.g. the resolved user id). */
  sub: string;
  /** Human-readable username surfaced to the upload path. */
  username: string;
  /** Permissions the key carries, resolved identically to UI login. */
  permissions: Permission[];
}

/**
 * Fully-decoded, verified agent-key payload. Returned by {@link verifyAgentKey}
 * on success.
 */
export interface VerifiedAgentKey extends AgentKeyClaims {
  aud: typeof AGENT_KEY_AUDIENCE;
  iss: typeof AGENT_KEY_ISSUER;
  iat: number;
  exp: number;
  jti: string;
}

/** Resolved Bearer identity handed to the upload routes and proxy. */
export interface BearerAuth {
  username: string;
  permissions: Permission[];
}

/**
 * Returns the signing secret as a Uint8Array suitable for HS256.
 * Prefers AGENT_KEY_SECRET, falling back to AUTH_SECRET (the next-auth secret).
 * Throws if neither is configured — minting without a secret must fail loudly,
 * and signing/verifying with an empty key would be a security hole. Verification
 * callers catch this and treat it as "not verified" (null) so a misconfigured
 * edge proxy denies rather than 500s; see {@link verifyAgentKey}.
 */
function getSigningKey(): Uint8Array {
  const secret = process.env.AGENT_KEY_SECRET ?? process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error('agent-key: no signing secret configured (set AGENT_KEY_SECRET or AUTH_SECRET)');
  }
  return new TextEncoder().encode(secret);
}

/**
 * Reads AGENT_KEY_TTL_SECONDS, falling back to {@link DEFAULT_AGENT_KEY_TTL_SECONDS},
 * and clamps the result to [{@link MIN_AGENT_KEY_TTL_SECONDS}, {@link MAX_AGENT_KEY_TTL_SECONDS}].
 * A non-numeric or non-positive value falls back to the default.
 */
export function resolveAgentKeyTtlSeconds(): number {
  const raw = process.env.AGENT_KEY_TTL_SECONDS;
  const parsed = raw === undefined ? NaN : Number(raw);
  const ttl = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AGENT_KEY_TTL_SECONDS;
  return Math.min(MAX_AGENT_KEY_TTL_SECONDS, Math.max(MIN_AGENT_KEY_TTL_SECONDS, Math.floor(ttl)));
}

/** Web Crypto-friendly random hex id for the `jti` claim (edge-safe). */
function randomJti(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Mints a short-lived, audience-scoped agent upload key.
 *
 * The returned compact JWS carries claims sub, username, permissions,
 * aud:"upload", iss:"brushpass", iat, exp, and jti, signed HS256 with
 * AGENT_KEY_SECRET ?? AUTH_SECRET. TTL comes from AGENT_KEY_TTL_SECONDS
 * (default 900s, clamped to a sane maximum).
 *
 * The returned key is a bearer credential and must never be logged.
 */
export async function mintAgentKey(claims: AgentKeyClaims): Promise<string> {
  const ttl = resolveAgentKeyTtlSeconds();
  const nowSeconds = Math.floor(Date.now() / 1000);

  return new SignJWT({
    username: claims.username,
    permissions: claims.permissions,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setAudience(AGENT_KEY_AUDIENCE)
    .setIssuer(AGENT_KEY_ISSUER)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + ttl)
    .setJti(randomJti())
    .sign(getSigningKey());
}

/**
 * Verifies an agent upload key.
 *
 * Checks the HS256 signature, the issuer, and expiry (via jose), and rejects
 * unless the audience is exactly "upload". Returns null on ANY failure — bad
 * signature, wrong/absent audience, wrong issuer, expired, malformed, missing
 * claims, or even an unconfigured signing secret — so callers (the upload
 * routes and the edge proxy) can treat the result as a simple
 * authenticated/unauthenticated decision and a misconfiguration denies access
 * rather than 500-ing every request.
 *
 * jose-only and edge-safe.
 */
export async function verifyAgentKey(token: string): Promise<VerifiedAgentKey | null> {
  if (!token) return null;

  let key: Uint8Array;
  try {
    key = getSigningKey();
  } catch {
    // No signing secret configured — cannot verify, so the key is not trusted.
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: AGENT_KEY_ISSUER,
      audience: AGENT_KEY_AUDIENCE,
      algorithms: ['HS256'],
    });

    // jwtVerify already enforced iss, aud, and exp. Defensively confirm the
    // shape we depend on before handing claims to the upload path.
    if (payload.aud !== AGENT_KEY_AUDIENCE) return null;
    if (typeof payload.sub !== 'string' || payload.sub === '') return null;
    if (typeof payload.username !== 'string') return null;
    if (!Array.isArray(payload.permissions)) return null;
    if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') return null;
    if (typeof payload.jti !== 'string') return null;

    return {
      sub: payload.sub,
      username: payload.username,
      permissions: payload.permissions as Permission[],
      aud: AGENT_KEY_AUDIENCE,
      iss: AGENT_KEY_ISSUER,
      iat: payload.iat,
      exp: payload.exp,
      jti: payload.jti,
    };
  } catch (err) {
    // Expected on any invalid/expired/wrong-audience token — not exceptional.
    if (err instanceof joseErrors.JOSEError) return null;
    // Re-throw genuinely unexpected errors.
    throw err;
  }
}

/**
 * Extracts the bearer token from a request's Authorization header.
 * Returns the raw token, or null if the header is absent or not a `Bearer` scheme.
 * Accepts a WHATWG Request or anything exposing `headers.get`.
 */
function extractBearerToken(request: { headers: { get(name: string): string | null } }): string | null {
  const header = request.headers.get('authorization') ?? request.headers.get('Authorization');
  if (!header) return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token === '' ? null : token;
}

/**
 * Resolves an agent identity from a request's `Authorization: Bearer <token>`
 * header. This is the single Bearer-resolution helper imported by the upload
 * routes and the proxy so there is exactly one verification path.
 *
 * Returns { username, permissions } on a valid aud:"upload" key, or null for a
 * missing, malformed, expired, wrong-audience, or otherwise invalid header.
 */
export async function resolveBearerAuth(
  request: { headers: { get(name: string): string | null } },
): Promise<BearerAuth | null> {
  const token = extractBearerToken(request);
  if (!token) return null;

  const claims = await verifyAgentKey(token);
  if (!claims) return null;

  return { username: claims.username, permissions: claims.permissions };
}
