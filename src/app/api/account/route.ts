export const runtime = 'nodejs';

import { type NextRequest } from 'next/server';
import { auth } from '@/auth';
import { getUserById, updateUser } from '@/lib/db';
import { hashPassword, verifyToken } from '@/lib/token';

export async function PATCH(request: NextRequest): Promise<Response> {
  let phase = 'auth';
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = parseInt(session.user.id, 10);

    phase = 'db-lookup';
    const user = getUserById(userId);
    if (!user) {
      return Response.json({ error: 'User not found', phase }, { status: 404 });
    }

    if (user.auth_provider !== 'credentials') {
      return Response.json(
        { error: 'Password change is not available for SSO accounts', phase },
        { status: 400 },
      );
    }

    if (!user.password_hash) {
      return Response.json(
        { error: 'Account has no password set', phase },
        { status: 400 },
      );
    }

    phase = 'body-parse';
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body', phase }, { status: 400 });
    }

    const { currentPassword, newPassword } = body as Record<string, unknown>;

    if (typeof currentPassword !== 'string' || !currentPassword) {
      return Response.json({ error: 'currentPassword is required', phase }, { status: 400 });
    }
    if (typeof newPassword !== 'string' || !newPassword) {
      return Response.json({ error: 'newPassword is required', phase }, { status: 400 });
    }
    if (newPassword.length < 8) {
      return Response.json({ error: 'New password must be at least 8 characters', phase }, { status: 400 });
    }

    phase = 'verify-password';
    const valid = await verifyToken(currentPassword, user.password_hash);
    if (!valid) {
      return Response.json({ error: 'Current password is incorrect', phase }, { status: 401 });
    }

    phase = 'hash';
    const password_hash = await hashPassword(newPassword);

    phase = 'db-update';
    updateUser(userId, { password_hash });

    console.log('[account] action=change-password user=%d', userId);
    return Response.json({ ok: true });
  } catch (err) {
    console.error('[account] phase=%s error=%s', phase, String(err));
    return Response.json({ error: 'Internal server error', phase }, { status: 500 });
  }
}
