/**
 * Authorization helper shared by the upload routes
 * (`/api/upload` and `/api/upload/complete`).
 *
 * The upload API accepts either the interactive cookie session (UI login) or a
 * short-lived, audience-scoped agent Bearer key minted by the device-grant
 * flow. This helper unifies the two: it prefers an existing cookie session
 * (whose permissions it re-reads from the database — the JWT claim identifies
 * the user, it does not authorize them) and, only when there is no session,
 * falls back to {@link resolveBearerAuth} — the single Bearer-resolution path
 * in `@/lib/agent-key`.
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
import { resolveActorFromDb } from '@/lib/admin-auth';
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
  user?: { id?: string; username?: string; permissions?: Permission[]; email?: string | null };
} | null;

/**
 * Resolves the actor authorized to drive the upload API.
 *
 * For a cookie session the PERMISSIONS are re-read from the database rather
 * than taken from the JWT claim, so a demoted or deleted user loses upload
 * access on their next request instead of when their session finally expires.
 * Agent Bearer keys are left as-is: they are audience-scoped and capped at 15
 * minutes, which is a tighter revocation bound than a DB read would add.
 *
 * Returns `null` when neither path authenticates — including a cookie session
 * whose user row is gone — so callers fall through to their existing Forbidden
 * response.
 */
export async function resolveUploadActor(
  session: CookieSession,
  request: { headers: { get(name: string): string | null } },
): Promise<UploadActor | null> {
  if (session) {
    const actor = await resolveActorFromDb(session.user?.id);
    if (!actor) return null;
    return {
      user: {
        // Identity strings still come from the session so the existing
        // username/email log fields are byte-for-byte preserved; only the
        // authorization input is re-sourced from the database.
        username: session.user?.username,
        email: session.user?.email ?? null,
        permissions: actor.permissions,
      },
    };
  }

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
