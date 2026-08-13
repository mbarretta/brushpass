import { auth } from '@/auth';
import type { Permission, SafeUser } from '@/types';

/**
 * Re-reads the user row a session claims to be, so authorization decisions come
 * from the DATABASE rather than from a JWT claim minted up to 8 hours ago.
 *
 * Without this, a demotion or a delete does not take effect until the victim's
 * session expires: their cookie keeps asserting `permissions: ['admin']`.
 * better-sqlite3 is synchronous and local, so the re-read costs microseconds.
 *
 * Returns null when the id is absent or unparseable, or when the row is gone —
 * a deleted user is revoked immediately, with no token bookkeeping to remember
 * to do. (The rejected alternative was a `token_version` column compared in the
 * jwt callback: it needs a migration, still costs a read per request, and only
 * revokes when someone remembers to bump it.)
 */
export async function resolveActorFromDb(userId: unknown): Promise<SafeUser | null> {
  if (typeof userId !== 'string' && typeof userId !== 'number') return null;
  const id = typeof userId === 'number' ? userId : /^\d+$/.test(userId) ? Number(userId) : NaN;
  if (!Number.isInteger(id) || id <= 0) return null;

  // Lazy import: better-sqlite3 is a native module and must never be pulled
  // into an Edge bundle through a static import chain.
  const { getUserById } = await import('@/lib/db');
  return getUserById(id) ?? null;
}

/**
 * The authenticated caller as the database currently sees them, or null when
 * there is no session or the session's user row no longer exists.
 */
export async function getCurrentActor(): Promise<SafeUser | null> {
  const session = await auth();
  return resolveActorFromDb(session?.user?.id);
}

/**
 * Returns true if the current request has an active session whose CURRENT
 * database row carries the admin permission. The JWT claim is only used to
 * identify which row to read.
 */
export async function getIsAdmin(): Promise<boolean> {
  const actor = await getCurrentActor();
  return actor?.permissions.includes('admin') ?? false;
}

/**
 * The single source of truth for allowed Permission values. Previously
 * declared inline in three places (admin user create, admin user patch, and
 * the self-service permission-request submission route) — hoisted here so
 * every caller validates against the same set.
 */
export const VALID_PERMISSIONS: Permission[] = ['upload', 'admin'];

/** True iff `value` is an array containing only values from VALID_PERMISSIONS. */
export function isValidPermissionsArray(value: unknown): value is Permission[] {
  return Array.isArray(value) && value.every((p) => VALID_PERMISSIONS.includes(p as Permission));
}
