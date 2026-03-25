import { auth } from '@/auth';

/**
 * Returns true if the current request has an active session with admin permission.
 * Replaces the S04 stub — now calls Auth.js auth() to validate the JWT session cookie.
 */
export async function getIsAdmin(): Promise<boolean> {
  const session = await auth();
  return session?.user?.permissions?.includes('admin') ?? false;
}
