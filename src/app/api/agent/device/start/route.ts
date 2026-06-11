/**
 * POST /api/agent/device/start
 *
 * Entry point of the brokered OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * The app brokers the exchange with the provider's device-authorization
 * endpoint using the *agent* OAuth client (AGENT_OIDC_CLIENT_ID), then hands the
 * agent only the user-facing fields (verification URI, user code, interval,
 * lifetime) plus an opaque `poll_token`. The confidential `device_code` is kept
 * server-side, stored under the SHA-256 hash of the poll_token via the device-
 * session helpers, so the agent never holds it. The companion
 * `POST /api/agent/device/token` route polls with the poll_token to complete the
 * grant.
 *
 * Runs on the Node.js runtime: it uses better-sqlite3 (via the db helpers) and
 * node:crypto for opaque-token generation/hashing.
 *
 * Security: the raw device_code is never returned to the caller or logged, and
 * neither is the poll_token's value beyond what the caller already holds.
 */
export const runtime = 'nodejs';

import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { getOidcDiscoveryDocument } from '@/lib/oidc-discovery';
import { createDeviceSession } from '@/lib/db';

/** OAuth scope requested for the brokered device grant. */
const DEVICE_SCOPE = 'openid email profile';

/**
 * Default polling interval (seconds) per RFC 8628 §3.2 when the provider omits
 * `interval` from its device-authorization response.
 */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

/** Subset of the RFC 8628 device-authorization response we depend on. */
interface DeviceAuthorizationResponse {
  device_code?: unknown;
  user_code?: unknown;
  verification_uri?: unknown;
  // Google historically uses `verification_url`; accept it as an alias.
  verification_url?: unknown;
  verification_uri_complete?: unknown;
  expires_in?: unknown;
  interval?: unknown;
}

/** Generates an opaque, URL-safe poll token (256 bits of entropy). */
function generatePollToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** SHA-256 hex digest used as the storage key for a poll token. */
function hashPollToken(pollToken: string): string {
  return crypto.createHash('sha256').update(pollToken).digest('hex');
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

export async function POST(): Promise<NextResponse> {
  const clientId = process.env.AGENT_OIDC_CLIENT_ID;
  if (!clientId) {
    console.error('[agent] action=device-start result=misconfigured reason=missing-client-id');
    return NextResponse.json({ error: 'Agent device grant not configured' }, { status: 503 });
  }

  try {
    const { device_authorization_endpoint } = await getOidcDiscoveryDocument();

    const response = await fetch(device_authorization_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({ client_id: clientId, scope: DEVICE_SCOPE }),
    });

    if (!response.ok) {
      // Do not echo the provider body — it may contain client identifiers.
      console.error('[agent] action=device-start result=upstream-error status=%d', response.status);
      return NextResponse.json({ error: 'Device authorization request failed' }, { status: 502 });
    }

    const data = (await response.json()) as DeviceAuthorizationResponse;

    const deviceCode = asNonEmptyString(data.device_code);
    const userCode = asNonEmptyString(data.user_code);
    const verificationUri = asNonEmptyString(data.verification_uri) ?? asNonEmptyString(data.verification_url);
    const expiresIn = asPositiveInt(data.expires_in);
    const interval = asPositiveInt(data.interval) ?? DEFAULT_POLL_INTERVAL_SECONDS;

    if (!deviceCode || !userCode || !verificationUri || expiresIn === null) {
      console.error('[agent] action=device-start result=invalid-upstream-response');
      return NextResponse.json({ error: 'Malformed device authorization response' }, { status: 502 });
    }

    const verificationUriComplete = asNonEmptyString(data.verification_uri_complete);

    const pollToken = generatePollToken();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAt = nowSeconds + expiresIn;

    // Store the confidential device_code server-side, keyed only by the hash of
    // the opaque poll_token. The raw poll_token is returned to the caller; only
    // its hash is persisted.
    createDeviceSession({
      poll_token_hash: hashPollToken(pollToken),
      device_code: deviceCode,
      interval,
      expires_at: expiresAt,
    });

    console.log('[agent] action=device-start result=ok interval=%d expires_in=%d', interval, expiresIn);

    return NextResponse.json({
      verification_uri: verificationUri,
      verification_uri_complete: verificationUriComplete,
      user_code: userCode,
      interval,
      expires_in: expiresIn,
      poll_token: pollToken,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[agent] action=device-start result=error error=%s', message);
    return NextResponse.json({ error: 'Device authorization failed' }, { status: 500 });
  }
}
