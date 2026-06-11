export const runtime = 'nodejs';

import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';

import { getOidcDiscoveryDocument } from '@/lib/oidc-discovery';
import {
  getDeviceSessionByPollTokenHash,
  updateDeviceSessionInterval,
  deleteDeviceSession,
} from '@/lib/db';
import { resolveOidcUserPermissions } from '@/auth';
import { mintAgentKey, resolveAgentKeyTtlSeconds } from '@/lib/agent-key';

/**
 * POST /api/agent/device/token — the poll/mint core of the brokered RFC 8628
 * Device Authorization Grant.
 *
 * The agent polls this route with the opaque `poll_token` it received from
 * /api/agent/device/start. We look up the server-side session (which holds the
 * raw Google device_code that the agent never sees), exchange it at the
 * discovered token_endpoint, and map Google's RFC 8628 polling statuses:
 *
 *   - authorization_pending → 202 { status: 'pending' }
 *   - slow_down             → bump the stored interval, 202 { status: 'slow_down', interval }
 *   - expired_token         → 400 { status: 'expired' }, session dropped
 *   - access_denied         → 403 { status: 'denied' },  session dropped
 *
 * On success we VERIFY the returned ID token (signature against the discovered
 * jwks_uri, issuer, aud === AGENT_OIDC_CLIENT_ID, expiry, and the email/hd
 * domain) BEFORE trusting any claim, resolve permissions through the same
 * helper UI login uses (so the agent gets exactly the UI permissions), mint the
 * scoped upload key, delete the session, and return the key.
 *
 * Security: the minted api_key, the device_code, and the Google tokens are
 * never logged.
 */

/** Grace this poll if it arrives within (interval - SLACK) seconds of the last one. */
const POLL_INTERVAL_SLACK_SECONDS = 1;

/** Seconds added to the interval each time we have to ask the agent to slow down. */
const SLOW_DOWN_INCREMENT_SECONDS = 5;

/** Upper bound on the backed-off interval so it cannot grow without limit. */
const MAX_POLL_INTERVAL_SECONDS = 60;

/**
 * Cap on the in-memory poll-time map. Entries are normally removed when a
 * session ends, but an agent that abandons polling without reaching a terminal
 * status would otherwise leak an entry until process restart; evicting the
 * oldest entry past this bound keeps the map from growing without limit.
 */
const MAX_TRACKED_SESSIONS = 10_000;

/**
 * In-memory record of when each session was last polled, keyed by
 * poll_token_hash. Lets us enforce the advertised polling interval without
 * touching Google: a poll that arrives too soon is answered with slow_down
 * rather than forwarded upstream. Entries are removed when the session ends.
 *
 * This is per-instance state; the agent-facing contract (do not poll faster
 * than `interval`) is advisory, and the proxy additionally rate-limits the
 * device_token category per IP (see t7).
 */
const lastPolledAt = new Map<string, number>();

/** Records this poll's time, evicting the oldest entry if the map is at capacity. */
function recordPoll(hash: string, atSeconds: number): void {
  if (!lastPolledAt.has(hash) && lastPolledAt.size >= MAX_TRACKED_SESSIONS) {
    const oldest = lastPolledAt.keys().next().value;
    if (oldest !== undefined) lastPolledAt.delete(oldest);
  }
  lastPolledAt.set(hash, atSeconds);
}

/** Bumps an interval by the slow-down increment, clamped to the maximum. */
function backoffInterval(current: number): number {
  return Math.min(MAX_POLL_INTERVAL_SECONDS, current + SLOW_DOWN_INCREMENT_SECONDS);
}

interface GoogleTokenSuccess {
  id_token?: string;
  access_token?: string;
  token_type?: string;
}

interface GoogleTokenError {
  error?: string;
  error_description?: string;
}

interface IdTokenClaims {
  email?: string;
  name?: string;
  hd?: string;
}

/** Deterministic SHA-256 of the poll_token; the table is keyed on this hash. */
function hashPollToken(pollToken: string): string {
  return crypto.createHash('sha256').update(pollToken).digest('hex');
}

/** Per-jwks_uri remote JWKS cache so we reuse jose's key cache across polls. */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function getRemoteJwks(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(jwksUri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri));
    jwksCache.set(jwksUri, jwks);
  }
  return jwks;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let pollToken: string;
  try {
    const body = (await request.json()) as { poll_token?: unknown };
    if (typeof body.poll_token !== 'string' || body.poll_token === '') {
      return NextResponse.json({ error: 'Missing poll_token' }, { status: 400 });
    }
    pollToken = body.poll_token;
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const pollTokenHash = hashPollToken(pollToken);
  const session = getDeviceSessionByPollTokenHash(pollTokenHash);

  if (!session) {
    // Unknown or already-consumed/dropped session. Treat as expired so a stale
    // poller stops looping. Never echo the poll_token.
    console.log('[agent] action=device-poll result=unknown_session');
    return NextResponse.json({ status: 'expired' }, { status: 400 });
  }

  const nowSeconds = Math.floor(Date.now() / 1000);

  // Drop a session whose own expiry has passed before we ever hit Google.
  if (session.expires_at <= nowSeconds) {
    deleteDeviceSession(pollTokenHash);
    lastPolledAt.delete(pollTokenHash);
    console.log('[agent] action=device-poll result=expired');
    return NextResponse.json({ status: 'expired' }, { status: 400 });
  }

  // Enforce the advertised polling interval locally: if the agent polls faster
  // than `interval`, answer slow_down without forwarding to Google.
  const last = lastPolledAt.get(pollTokenHash);
  if (last !== undefined && nowSeconds - last < session.interval - POLL_INTERVAL_SLACK_SECONDS) {
    const interval = backoffInterval(session.interval);
    updateDeviceSessionInterval(pollTokenHash, interval);
    console.log('[agent] action=device-poll result=slow_down interval=%d', interval);
    return NextResponse.json({ status: 'slow_down', interval }, { status: 202 });
  }
  recordPoll(pollTokenHash, nowSeconds);

  let discovery;
  try {
    discovery = await getOidcDiscoveryDocument();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[agent] action=device-poll result=discovery_error error=%s', message);
    return NextResponse.json({ error: 'OIDC discovery failed' }, { status: 500 });
  }

  const clientId = process.env.AGENT_OIDC_CLIENT_ID ?? '';
  const clientSecret = process.env.AGENT_OIDC_CLIENT_SECRET ?? '';
  if (!clientId || !clientSecret) {
    console.error('[agent] action=device-poll result=misconfigured');
    return NextResponse.json({ error: 'Agent OIDC client not configured' }, { status: 500 });
  }

  // Exchange the server-held device_code at the discovered token endpoint.
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        device_code: session.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[agent] action=device-poll result=token_endpoint_error error=%s', message);
    return NextResponse.json({ error: 'Token exchange failed' }, { status: 502 });
  }

  const payload = (await tokenResponse.json().catch(() => ({}))) as
    | (GoogleTokenSuccess & GoogleTokenError)
    | Record<string, never>;

  // RFC 8628 polling-status mapping on a non-2xx (or error-bearing) response.
  if (!tokenResponse.ok || payload.error) {
    const code = payload.error ?? 'invalid_response';
    switch (code) {
      case 'authorization_pending':
        console.log('[agent] action=device-poll result=pending');
        return NextResponse.json({ status: 'pending' }, { status: 202 });

      case 'slow_down': {
        // Honor Google's request to back off: increase the stored interval.
        const interval = backoffInterval(session.interval);
        updateDeviceSessionInterval(pollTokenHash, interval);
        console.log('[agent] action=device-poll result=slow_down interval=%d', interval);
        return NextResponse.json({ status: 'slow_down', interval }, { status: 202 });
      }

      case 'access_denied':
        deleteDeviceSession(pollTokenHash);
        lastPolledAt.delete(pollTokenHash);
        console.log('[agent] action=device-poll result=denied');
        return NextResponse.json({ status: 'denied' }, { status: 403 });

      case 'expired_token':
        deleteDeviceSession(pollTokenHash);
        lastPolledAt.delete(pollTokenHash);
        console.log('[agent] action=device-poll result=expired');
        return NextResponse.json({ status: 'expired' }, { status: 400 });

      default:
        // Any other OAuth error is terminal — drop the session so the agent stops.
        deleteDeviceSession(pollTokenHash);
        lastPolledAt.delete(pollTokenHash);
        console.error('[agent] action=device-poll result=error code=%s', code);
        return NextResponse.json({ status: 'error', error: code }, { status: 400 });
    }
  }

  // ── Success: verify the ID token BEFORE trusting any claim ──────────────────
  const idToken = payload.id_token;
  if (!idToken) {
    deleteDeviceSession(pollTokenHash);
    lastPolledAt.delete(pollTokenHash);
    console.error('[agent] action=device-poll result=no_id_token');
    return NextResponse.json({ status: 'error', error: 'no_id_token' }, { status: 400 });
  }

  let claims: IdTokenClaims;
  try {
    const jwks = getRemoteJwks(discovery.jwks_uri);
    const { payload: verified } = await jwtVerify(idToken, jwks, {
      issuer: discovery.issuer,
      audience: clientId,
    });
    claims = verified as IdTokenClaims;
  } catch (err) {
    // A token that fails signature/issuer/audience/expiry checks is untrusted.
    deleteDeviceSession(pollTokenHash);
    lastPolledAt.delete(pollTokenHash);
    const message = err instanceof Error ? err.message : String(err);
    console.error('[agent] action=device-poll result=id_token_invalid error=%s', message);
    return NextResponse.json({ status: 'error', error: 'id_token_invalid' }, { status: 403 });
  }

  const email = claims.email ?? '';
  const domain = email.split('@')[1] ?? '';
  const expectedDomain = process.env.AUTH_OIDC_ADMIN_DOMAIN ?? '';
  // If an admin domain is configured, the email/hd domain must match it before
  // we mint. Mirrors the UI-login trust boundary; with no domain configured we
  // still require a non-empty verified email.
  if (!email) {
    deleteDeviceSession(pollTokenHash);
    lastPolledAt.delete(pollTokenHash);
    console.error('[agent] action=mint result=no_email');
    return NextResponse.json({ status: 'error', error: 'no_email' }, { status: 403 });
  }
  if (expectedDomain && domain !== expectedDomain && claims.hd !== expectedDomain) {
    deleteDeviceSession(pollTokenHash);
    lastPolledAt.delete(pollTokenHash);
    console.error('[agent] action=mint result=domain_rejected domain=%s', domain);
    return NextResponse.json({ status: 'denied' }, { status: 403 });
  }

  // Resolve permissions through the single source of truth (t3) and mint.
  const resolved = await resolveOidcUserPermissions({ email, name: claims.name ?? null });
  const apiKey = await mintAgentKey({
    sub: String(resolved.id),
    username: resolved.email,
    permissions: resolved.permissions,
  });

  // Session is single-use: drop it so the poll_token cannot mint twice.
  deleteDeviceSession(pollTokenHash);
  lastPolledAt.delete(pollTokenHash);

  // expires_at mirrors mintAgentKey's own exp computation (now + clamped TTL)
  // from the shared key util — no need to parse the key we just signed.
  const expiresAt = nowSeconds + resolveAgentKeyTtlSeconds();

  console.log('[agent] action=mint result=success username=%s', resolved.email);
  return NextResponse.json({
    api_key: apiKey,
    token_type: 'Bearer',
    expires_at: expiresAt,
    permissions: resolved.permissions,
  });
}
