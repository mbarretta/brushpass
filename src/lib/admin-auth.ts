import { auth } from '@/auth';
import type { Permission } from '@/types';

/**
 * Returns true if the current request has an active session with admin permission.
 * Replaces the S04 stub — now calls Auth.js auth() to validate the JWT session cookie.
 */
export async function getIsAdmin(): Promise<boolean> {
  const session = await auth();
  return session?.user?.permissions?.includes('admin') ?? false;
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
