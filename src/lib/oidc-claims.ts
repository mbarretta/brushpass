/**
 * Pure parsing of OIDC ID-token claims.
 *
 * Lives outside `src/auth.ts` so both the Auth.js config and the agent
 * device-grant mint route can share one implementation, and so it can be tested
 * without mocking next-auth (importing `@/auth` pulls in `next-auth`, which does
 * not load outside a request context).
 */

/**
 * Extracts the domain from an email address, or null when the value is not a
 * single unambiguous `local@domain` pair.
 *
 * `email.split('@')[1]` (the previous behavior at both call sites) reads the
 * SECOND field of an address containing several `@`s, so
 * `victim@example.com@attacker.io` resolved to `example.com` — enough to pass an
 * admin-domain check with a mailbox the admin domain does not control.
 * Requiring exactly one `@`, with non-empty whitespace-free text on both sides,
 * is what closes that.
 *
 * The result is lower-cased so domain comparisons are case-insensitive, as DNS
 * is.
 */
export function emailDomain(email: string): string | null {
  const parts = email.trim().split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (local === '' || domain === '') return null;
  if (/\s/.test(local) || /\s/.test(domain)) return null;
  return domain.toLowerCase();
}
