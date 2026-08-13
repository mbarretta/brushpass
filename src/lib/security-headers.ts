/**
 * The application's response security-header baseline.
 *
 * TWO CONSUMERS, ONE DEFINITION. These headers are applied from two places and
 * both import this module, so the two can never drift:
 *
 *  1. `next.config.ts`'s `headers()` — the static baseline. Next checks
 *     configured headers BEFORE the filesystem (see
 *     node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/headers.md),
 *     so this covers responses the Edge proxy never sees at all: `/public`
 *     assets such as `/brushpass-logo.png`, and anything else the proxy matcher
 *     deliberately excludes.
 *  2. `withSecurityHeaders()` in `src/proxy.ts` — every response the proxy
 *     itself produces (`next()`, the `/login` redirect, the 429, both 403s).
 *     A proxy-generated response short-circuits routing, so it cannot rely on
 *     consumer 1.
 *
 * Deliberately free of node-only imports so the Edge proxy bundle can load it.
 */

/**
 * Hosts the browser must be allowed to talk to besides the app's own origin.
 *
 * The upload flow PUTs file bytes straight to a signed GCS URL via
 * XMLHttpRequest (`src/app/upload/UploadForm.tsx`,
 * `src/app/admin/groups/[slug]/GroupUpload.tsx`), which is the whole point of
 * the direct-to-GCS design — it keeps multi-hundred-MB uploads off Cloud Run.
 * Omitting this host is the one CSP mistake that would break uploads outright.
 */
export const GCS_ORIGIN = 'https://storage.googleapis.com';

/**
 * `'unsafe-eval'` is needed only by the dev server's HMR/eval pipeline; a
 * production Next build never eval()s. Keeping it out of the production policy
 * means the Report-Only violations we collect describe the policy we actually
 * intend to enforce, while local `next dev` does not drown in noise.
 */
const scriptSrc =
  process.env.NODE_ENV === 'development'
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'";

/**
 * The content security policy, shipped in Report-Only mode (see
 * {@link SECURITY_HEADERS}).
 *
 * `'unsafe-inline'` is present for both scripts and styles because the App
 * Router emits inline bootstrap/flight scripts and inline style tags on every
 * page. Removing it requires a per-request nonce, which in turn forces dynamic
 * rendering on every page — a deliberate follow-up, not part of this change.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  // Belt-and-braces with X-Frame-Options: DENY below, for browsers that honor
  // CSP framing rules but not the legacy header.
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  scriptSrc,
  `connect-src 'self' ${GCS_ORIGIN}`,
  'upgrade-insecure-requests',
].join('; ');

/**
 * The header baseline.
 *
 * NOTE ON THE CSP HEADER NAME — this ships as
 * `Content-Security-Policy-Report-Only`, which observes and reports but blocks
 * nothing. That is deliberate for this change: the policy above still needs
 * `'unsafe-inline'` for scripts, so enforcing it today would buy little while
 * risking a hard breakage on a page nobody re-tested. Flipping the key to
 * `Content-Security-Policy` is the follow-up, and it should land together with
 * the nonce work that lets `'unsafe-inline'` be dropped. Until then, violations
 * surface in the browser console (no reporting endpoint is configured yet).
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy-Report-Only': CONTENT_SECURITY_POLICY,
  // Two years, matching the common HSTS baseline. `includeSubDomains` scopes to
  // subdomains of the app's own host only. `preload` is deliberately omitted:
  // submission to the browser preload list is effectively irreversible and is
  // the owner's call, not a code change's.
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});

/**
 * The baseline shaped as Next's `headers()` entries (`{ key, value }`), so
 * `next.config.ts` does not have to restate the list.
 */
export function securityHeaderEntries(): { key: string; value: string }[] {
  return Object.entries(SECURITY_HEADERS).map(([key, value]) => ({ key, value }));
}
