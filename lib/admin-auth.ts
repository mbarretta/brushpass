/**
 * Admin authentication stub.
 * S04 replaces this with a real session check (cookie/JWT validation).
 * Until then, all admin routes are open in dev — do NOT deploy without S04.
 */
export function getIsAdmin(_req: Request): boolean {
  return true; // TODO S04: replace with real session check
}
