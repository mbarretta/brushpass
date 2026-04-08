export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getDb, createPermissionRequest } from '@/lib/db';
import type { Permission } from '@/types';

export async function POST(req: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let permissions: unknown;
  try {
    const body = await req.json();
    permissions = body.permissions;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const validPermissions: Permission[] = ['upload', 'admin'];
  if (
    !Array.isArray(permissions) ||
    permissions.length === 0 ||
    !permissions.every((p) => validPermissions.includes(p as Permission))
  ) {
    return NextResponse.json({ error: 'Invalid permissions' }, { status: 400 });
  }

  const userId = parseInt(session.user.id, 10);

  // Application-layer duplicate check — dedup without a unique constraint conflict
  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM permission_requests WHERE user_id = ?')
    .get(userId);
  if (existing) {
    return NextResponse.json({ ok: true, alreadyPending: true });
  }

  createPermissionRequest(userId, permissions as Permission[]);
  return NextResponse.json({ ok: true }, { status: 201 });
}
