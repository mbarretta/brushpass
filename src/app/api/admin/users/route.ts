export const runtime = 'nodejs';

import { type NextRequest } from 'next/server';
import { listUsers, createUser } from '@/lib/db';
import { getIsAdmin } from '@/lib/admin-auth';
import { hashPassword } from '@/lib/token';
import type { Permission } from '@/types';

export async function GET(_request: NextRequest): Promise<Response> {
  let phase = 'auth';
  try {
    if (!(await getIsAdmin())) {
      return Response.json({ error: 'Forbidden', phase: 'auth' }, { status: 403 });
    }

    phase = 'db-list';
    const users = listUsers();
    const safe = users.map(({ password_hash: _ph, ...rest }) => rest);

    console.log('[admin] action=list-users count=%d', safe.length);
    return Response.json(safe);
  } catch (err) {
    console.error('[admin] phase=%s error=%s', phase, String(err));
    return Response.json({ error: 'Internal server error', phase }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  let phase = 'auth';
  try {
    if (!(await getIsAdmin())) {
      return Response.json({ error: 'Forbidden', phase: 'auth' }, { status: 403 });
    }

    phase = 'body-parse';
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body', phase: 'body-parse' }, { status: 400 });
    }

    const { username, password, permissions } = body as Record<string, unknown>;
    if (!username || !password || !permissions) {
      return Response.json(
        { error: 'username, password, and permissions are required', phase: 'body-parse' },
        { status: 400 },
      );
    }
    if (typeof username !== 'string' || typeof password !== 'string' || !Array.isArray(permissions)) {
      return Response.json(
        { error: 'username and password must be strings; permissions must be an array', phase: 'body-parse' },
        { status: 400 },
      );
    }

    phase = 'hash';
    const password_hash = await hashPassword(password);

    phase = 'db-create';
    const user = createUser({
      username,
      password_hash,
      permissions: permissions as Permission[],
    });

    const { password_hash: _ph, ...safe } = user;

    console.log('[admin] action=create-user username=%s', username);
    return Response.json(safe, { status: 201 });
  } catch (err) {
    console.error('[admin] phase=%s error=%s', phase, String(err));
    // Unique constraint violation
    if (String(err).includes('UNIQUE constraint failed')) {
      return Response.json({ error: 'Username already exists', phase }, { status: 409 });
    }
    return Response.json({ error: 'Internal server error', phase }, { status: 500 });
  }
}
