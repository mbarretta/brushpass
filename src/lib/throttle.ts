/**
 * Client-IP resolution, transport rate limiting, and failed-login lockout.
 *
 * Extracted from `src/proxy.ts` so the same primitives can run on both sides of
 * the trust boundary: the Edge proxy sees every request, but only the Node
 * credentials path sees every *login*.
 *
 * TWO MAP INSTANCES, NOT ONE. This module is imported by the Edge proxy
 * (`src/proxy.ts`) and by the Node credentials path (`authorizeCredentials` in
 * `src/auth.ts`). Those load in different runtimes, so each holds its own copy
 * of the maps below and the counters are never shared. That is deliberate —
 * they are two independent layers:
 *
 *  - The proxy layer is a cheap transport-level cap. A caller can sidestep it
 *    by choosing a different transport for the same login (the server-action
 *    `POST /login` vs the `POST /api/auth/callback/credentials` that Auth.js
 *    exposes), which is exactly why it cannot be the only layer.
 *  - The in-`authorize` lockout is the authoritative one: every credentials
 *    login converges on `authorizeCredentials` regardless of transport, so a
 *    counter kept there cannot be bypassed by switching transports.
 *
 * Deliberately free of node-only imports (no `better-sqlite3`, no `crypto`) so
 * the Edge bundle can load it.
 *
 * Both stores are in-memory and therefore per-instance. Correct for this
 * single-instance Cloud Run deployment; a multi-instance deployment needs a
 * shared store (Redis/Firestore) or the caps become per-instance caps.
 */

// The generic "anything with headers.get()" shape now lives in @/lib/http next
// to the other transport-level helpers; re-exported here so existing importers
// of @/lib/throttle (src/auth.ts, tests/unit/throttle.test.ts) keep working.
import type { HeaderSource } from '@/lib/http';
export type { HeaderSource };

// ── Client IP resolution ──────────────────────────────────────────────────────

/**
 * How many additional proxies we operate *in front of* the platform proxy that
 * appends the real client IP. Default 0: correct for this deployment, which has
 * no global load balancer, only a Cloud Run domain mapping, so Google's front
 * end appends the true client IP as the LAST `x-forwarded-for` entry.
 */
export const DEFAULT_TRUSTED_PROXY_HOPS = 0;

/** Returned by {@link getClientIp} when no header identifies the caller. */
export const UNKNOWN_IP = 'unknown';

/** Set once a malformed value has been reported, so a typo cannot flood the log
 * at request rate. */
let warnedAboutHops = false;

/** Read once per call so tests (and a redeploy-free env change) take effect. */
function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TRUSTED_PROXY_HOPS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    if (!warnedAboutHops) {
      warnedAboutHops = true;
      console.warn(
        '[throttle] TRUSTED_PROXY_HOPS=%s is not a non-negative integer; using %d',
        raw,
        DEFAULT_TRUSTED_PROXY_HOPS,
      );
    }
    return DEFAULT_TRUSTED_PROXY_HOPS;
  }
  return parsed;
}

/**
 * Resolves the client IP from the RIGHT-hand end of `x-forwarded-for`.
 *
 * Everything to the left of the last entry was supplied by the caller and is
 * therefore attacker-controlled: reading `split(',')[0]` (the previous
 * behavior) let anyone reset any rate-limit counter by rotating one header
 * value. The last entry is appended by the infrastructure we actually trust;
 * `TRUSTED_PROXY_HOPS` walks further left by exactly the number of proxies we
 * run ourselves, and never past the start of the list.
 */
export function getClientIp(req: HeaderSource): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const hops = forwarded
      .split(',')
      .map((hop) => hop.trim())
      .filter((hop) => hop !== '');
    if (hops.length > 0) {
      const index = hops.length - 1 - trustedProxyHops();
      return hops[index >= 0 ? index : 0];
    }
  }
  const realIp = req.headers.get('x-real-ip')?.trim();
  return realIp ? realIp : UNKNOWN_IP;
}

// ── Sliding-window transport rate limiter ─────────────────────────────────────
// Keyed by "route-category:ip". Entries expire after the window elapses.

interface WindowEntry {
  count: number;
  windowStart: number;
}

const rateLimitStore = new Map<string, WindowEntry>();

const RATE_LIMITS: Record<string, { max: number; windowMs: number }> = {
  login: { max: 10, windowMs: 60_000 },
  download: { max: 30, windowMs: 60_000 },
  account: { max: 3, windowMs: 60_000 },
  // /api/cleanup is self-authenticating (see selfAuthenticatingRoute in the
  // proxy) and therefore reachable by an unauthenticated caller; cap it so
  // hammering it cannot drive verifyOidcToken's outbound fetch to Google's
  // certs.
  cleanup: { max: 10, windowMs: 60_000 },
  // Agent device-grant endpoints. device_start opens a new device session;
  // device_token is the agent's polling loop, capped per IP here while the
  // token route additionally enforces the per-poll_token advertised interval.
  device_start: { max: 5, windowMs: 60_000 },
  device_token: { max: 30, windowMs: 60_000 },
  // Anonymous group-token surfaces. Each request costs one bcrypt compare at
  // cost 10 (~60ms of CPU on this single-instance service), so leaving them
  // uncapped is both a CPU-exhaustion surface and free token guessing.
  // group_access is a single interactive unlock, so its cap is tight;
  // group_download matches `download` because a visitor legitimately fetches
  // one member file per click.
  group_access: { max: 10, windowMs: 60_000 },
  group_download: { max: 30, windowMs: 60_000 },
};

export function isRateLimited(category: string, ip: string): boolean {
  const limit = RATE_LIMITS[category];
  if (!limit) return false;

  const key = `${category}:${ip}`;
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry || now - entry.windowStart > limit.windowMs) {
    rateLimitStore.set(key, { count: 1, windowStart: now });
    return false;
  }

  entry.count++;
  if (entry.count > limit.max) return true;
  return false;
}

const GROUP_ACCESS_PATH = /^\/api\/groups\/[^/]+\/access$/;
const GROUP_FILE_PATH = /^\/api\/groups\/[^/]+\/files\/[^/]+$/;

/**
 * Maps a request to a rate-limit category, or null when it is uncapped.
 *
 * `method` is optional so the pure-path call sites (and the existing tests)
 * keep working, but the proxy always passes it: `/login` must only be capped on
 * POST. Capping the GET would let a user lock themselves out of the login form
 * by reloading the page.
 */
export function getRateLimitCategory(pathname: string, method?: string): string | null {
  const isPost = method?.toUpperCase() === 'POST';

  // Both credentials-login transports converge on the same category: the
  // Auth.js callback endpoint and the server-action POST to the login page
  // itself, which is what src/app/login/actions.ts actually uses.
  if (pathname === '/api/auth/callback/credentials') return 'login';
  if (isPost && pathname === '/login') return 'login';
  if (pathname.startsWith('/api/download/')) return 'download';
  if (pathname === '/api/account') return 'account';
  if (pathname === '/api/cleanup') return 'cleanup';
  if (pathname === '/api/agent/device/start') return 'device_start';
  if (pathname === '/api/agent/device/token') return 'device_token';
  if (isPost && GROUP_ACCESS_PATH.test(pathname)) return 'group_access';
  if (GROUP_FILE_PATH.test(pathname)) return 'group_download';
  return null;
}

// ── Failed-login lockout ──────────────────────────────────────────────────────
// A second, coarser window: rate limiting caps request VOLUME per category,
// this caps consecutive FAILURES per identity. Keys carry their own category
// prefix so one store serves both the username and the client-IP dimension.

const failureStore = new Map<string, WindowEntry>();

const FAILURE_LIMITS: Record<string, { max: number; windowMs: number }> = {
  // Five wrong passwords for one account locks that account's login for the
  // window, whatever IP the guesses come from.
  login_user: { max: 5, windowMs: 15 * 60_000 },
  // Looser, because a NAT or corporate egress legitimately shares one IP.
  // It still caps credential-stuffing that rotates the username each try.
  login_ip: { max: 20, windowMs: 15 * 60_000 },
};

/** Lockout key for a username. Lower-cased so case variants share a counter. */
export function loginUserKey(username: string): string {
  return `login_user:${username.toLowerCase()}`;
}

/**
 * Lockout key for a client IP, as resolved by {@link getClientIp}, or null when
 * the IP could not be resolved at all.
 *
 * Returning null for `UNKNOWN_IP` matters: without it every caller behind a
 * header-stripping proxy (and every request in local dev, where there is no
 * x-forwarded-for) would share ONE counter, and 20 failures from anybody would
 * lock credentials login for everybody. An unresolvable IP is not an identity,
 * so the IP dimension simply does not apply; the username dimension still does.
 */
export function loginIpKey(ip: string): string | null {
  return ip === UNKNOWN_IP ? null : `login_ip:${ip}`;
}

function failureLimitFor(key: string): { max: number; windowMs: number } | undefined {
  return FAILURE_LIMITS[key.slice(0, key.indexOf(':'))];
}

/**
 * True once `key` has reached its failure budget inside the current window.
 * Callers must check this BEFORE verifying a secret — the point is to stop
 * spending bcrypt compares on a guessing run.
 */
export function isLockedOut(key: string): boolean {
  const limit = failureLimitFor(key);
  if (!limit) return false;

  const entry = failureStore.get(key);
  if (!entry) return false;
  if (Date.now() - entry.windowStart > limit.windowMs) {
    failureStore.delete(key);
    return false;
  }
  return entry.count >= limit.max;
}

/** Records one failed attempt against `key`, starting a new window if stale. */
export function recordFailure(key: string): void {
  const limit = failureLimitFor(key);
  if (!limit) return;

  const now = Date.now();
  const entry = failureStore.get(key);
  if (!entry || now - entry.windowStart > limit.windowMs) {
    failureStore.set(key, { count: 1, windowStart: now });
    return;
  }
  entry.count++;
}

/** Clears the counter for `key`. Called only after a secret actually verifies. */
export function clearFailures(key: string): void {
  failureStore.delete(key);
}

/**
 * Test-only: drops all in-memory state — both counter maps and the
 * warned-about-a-bad-env-var latch — so cases cannot leak into each other.
 */
export function _resetThrottleState(): void {
  rateLimitStore.clear();
  failureStore.clear();
  warnedAboutHops = false;
}

// ── Stale-entry sweep ─────────────────────────────────────────────────────────
// Both stores are unbounded in principle (one key per IP/username seen), so
// evict entries whose window has long since closed.

const SWEEP_INTERVAL_MS = 5 * 60_000;

function sweep(store: Map<string, WindowEntry>, maxWindowMs: number): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now - entry.windowStart > maxWindowMs) store.delete(key);
  }
}

if (typeof setInterval !== 'undefined') {
  const handle = setInterval(() => {
    sweep(rateLimitStore, Math.max(...Object.values(RATE_LIMITS).map((l) => l.windowMs)));
    sweep(failureStore, Math.max(...Object.values(FAILURE_LIMITS).map((l) => l.windowMs)));
  }, SWEEP_INTERVAL_MS);
  // Node only (Edge timers have no unref): a housekeeping timer must not keep
  // the process — or a test run — alive.
  (handle as unknown as { unref?: () => void }).unref?.();
}
