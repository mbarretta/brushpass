/**
 * Authorization helper shared by the upload routes
 * (`/api/upload` and `/api/upload/complete`).
 *
 * The upload API accepts either the interactive cookie session (UI login) or a
 * short-lived, audience-scoped agent Bearer key minted by the device-grant
 * flow. This helper unifies the two: it prefers an existing cookie session and,
 * only when that yields no session, falls back to {@link resolveBearerAuth} —
 * the single Bearer-resolution path in `@/lib/agent-key`.
 *
 * On a valid `aud:"upload"` Bearer it synthesizes the same
 * `{ user: { username, permissions, email } }` shape the cookie session
 * produces, so the existing permission check, collision detection, signed-URL
 * generation, and token issuance in the routes run unchanged. A missing,
 * invalid, expired, or wrong-audience Bearer simply yields `null`, leaving the
 * routes' existing 403 `{ error: 'Forbidden', phase: ... }` behavior intact.
 *
 * The minted key is never logged here; Bearer parsing and verification live
 * entirely in `@/lib/agent-key`.
 */
import { resolveBearerAuth } from '@/lib/agent-key';
import type { Permission } from '@/types';

/**
 * Minimal session/actor shape the upload routes consume: they read only
 * `user.permissions`, `user.username`, and `user.email`. Both the next-auth
 * cookie `Session` and a synthesized Bearer actor satisfy this.
 */
export interface UploadActor {
  user: {
    username?: string;
    permissions: Permission[];
    email?: string | null;
  };
}

/** The subset of a cookie session this helper depends on (next-auth `Session`). */
type CookieSession = {
  user?: { username?: string; permissions?: Permission[]; email?: string | null };
} | null;

/**
 * Resolves the actor authorized to drive the upload API.
 *
 * Returns the cookie session unchanged when one is present; otherwise attempts
 * agent Bearer resolution and synthesizes an equivalent actor. Returns `null`
 * when neither path authenticates, so callers fall through to their existing
 * Forbidden response.
 */
export async function resolveUploadActor(
  session: CookieSession,
  request: { headers: { get(name: string): string | null } },
): Promise<UploadActor | null> {
  // A cookie session is returned unchanged so cookie-login behavior — including
  // the existing username/email log fields — is byte-for-byte preserved.
  if (session) return session as UploadActor;

  const bearer = await resolveBearerAuth(request);
  if (!bearer) return null;

  return {
    user: {
      username: bearer.username,
      permissions: bearer.permissions,
      email: null,
    },
  };
}
