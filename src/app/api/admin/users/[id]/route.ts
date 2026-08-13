export const runtime = 'nodejs';

import { type NextRequest } from 'next/server';
import { getUserById, updateUser, deleteUser } from '@/lib/db';
import { getIsAdmin, isValidPermissionsArray } from '@/lib/admin-auth';
import { parseId, readJson } from '@/lib/http';
import { hashPassword, validatePassword, validateUsername } from '@/lib/token';
import { auth } from '@/auth';
import type { Permission } from '@/types';

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params): Promise<Response> {
  let phase = 'auth';
  try {
    if (!(await getIsAdmin())) {
      return Response.json({ error: 'Forbidden', phase: 'auth' }, { status: 403 });
    }

    phase = 'params';
    const { id } = await params;
    const numericId = parseId(id);
    if (numericId === null) {
      return Response.json({ error: 'Invalid id', phase: 'params' }, { status: 400 });
    }

    phase = 'db-lookup';
    const user = getUserById(numericId);
    if (!user) {
      return Response.json({ error: 'User not found', phase: 'db-lookup' }, { status: 404 });
    }

    // getUserById() already projects out password_hash — no strip needed.
    console.log('[admin] action=get-user id=%d', numericId);
    return Response.json(user);
  } catch (err) {
    console.error('[admin] phase=%s error=%s', phase, String(err));
    return Response.json({ error: 'Internal server error', phase }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: Params): Promise<Response> {
  let phase = 'auth';
  try {
    if (!(await getIsAdmin())) {
      return Response.json({ error: 'Forbidden', phase: 'auth' }, { status: 403 });
    }

    phase = 'params';
    const { id } = await params;
    const numericId = parseId(id);
    if (numericId === null) {
      return Response.json({ error: 'Invalid id', phase: 'params' }, { status: 400 });
    }

    phase = 'body-parse';
    const parsed = await readJson(request);
    if (!parsed.ok) return parsed.response;

    const { username, password, permissions } = parsed.body as Record<string, unknown>;

    phase = 'build-patch';
    const patch: { username?: string; password_hash?: string; permissions?: Permission[] } = {};

    if (username !== undefined) {
      if (typeof username !== 'string') {
        return Response.json({ error: 'username must be a string', phase }, { status: 400 });
      }
      const usernameCheck = validateUsername(username);
      if (!usernameCheck.ok) {
        return Response.json({ error: usernameCheck.error, phase }, { status: 400 });
      }
      patch.username = username;
    }
    if (password !== undefined) {
      if (typeof password !== 'string') {
        return Response.json({ error: 'password must be a string', phase }, { status: 400 });
      }

      // Mirrors /api/account's check: an admin resetting a password must not
      // silently give an SSO account a local credential that bypasses the
      // IdP (and whatever MFA it enforces).
      phase = 'db-lookup';
      const targetUser = getUserById(numericId);
      if (!targetUser) {
        return Response.json({ error: 'User not found', phase }, { status: 404 });
      }
      if (targetUser.auth_provider !== 'credentials') {
        return Response.json(
          { error: 'Password change is not available for SSO accounts', phase },
          { status: 400 },
        );
      }

      phase = 'password-validate';
      const passwordCheck = validatePassword(password);
      if (!passwordCheck.ok) {
        return Response.json({ error: passwordCheck.error, phase }, { status: 400 });
      }

      phase = 'hash';
      patch.password_hash = await hashPassword(password);
      phase = 'build-patch';
    }
    if (permissions !== undefined) {
      if (!Array.isArray(permissions)) {
        return Response.json({ error: 'permissions must be an array', phase }, { status: 400 });
      }
      if (!isValidPermissionsArray(permissions)) {
        return Response.json(
          { error: 'permissions contains invalid values; allowed: upload, admin', phase },
          { status: 400 },
        );
      }
      patch.permissions = permissions as Permission[];
    }

    phase = 'db-update';
    updateUser(numericId, patch);

    console.log('[admin] action=update-user id=%d fields=%s', numericId, Object.keys(patch).join(','));
    return Response.json({ ok: true });
  } catch (err) {
    console.error('[admin] phase=%s error=%s', phase, String(err));
    if (String(err).includes('UNIQUE constraint failed')) {
      return Response.json({ error: 'Username already exists', phase }, { status: 409 });
    }
    return Response.json({ error: 'Internal server error', phase }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Params): Promise<Response> {
  let phase = 'auth';
  try {
    if (!(await getIsAdmin())) {
      return Response.json({ error: 'Forbidden', phase: 'auth' }, { status: 403 });
    }

    phase = 'params';
    const { id } = await params;
    const numericId = parseId(id);
    if (numericId === null) {
      return Response.json({ error: 'Invalid id', phase: 'params' }, { status: 400 });
    }

    phase = 'self-check';
    const session = await auth();
    if (String(session?.user?.id) === String(numericId)) {
      return Response.json({ error: 'Cannot delete your own account', phase: 'self-check' }, { status: 400 });
    }

    phase = 'db-lookup';
    const user = getUserById(numericId);
    if (!user) {
      return Response.json({ error: 'User not found', phase: 'db-lookup' }, { status: 404 });
    }

    phase = 'db-delete';
    deleteUser(numericId);

    console.log('[admin] action=delete-user id=%d username=%s', numericId, user.username);
    return Response.json({ ok: true });
  } catch (err) {
    console.error('[admin] phase=%s error=%s', phase, String(err));
    return Response.json({ error: 'Internal server error', phase }, { status: 500 });
  }
}
