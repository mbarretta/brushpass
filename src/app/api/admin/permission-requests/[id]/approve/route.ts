export const runtime = 'nodejs';

import { type NextRequest } from 'next/server';
import { getIsAdmin } from '@/lib/admin-auth';
import { getDb, approvePermissionRequest } from '@/lib/db';
import type { Permission } from '@/types';

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, { params }: Params): Promise<Response> {
  let phase = 'auth';
  try {
    if (!(await getIsAdmin())) {
      return Response.json({ error: 'Forbidden', phase: 'auth' }, { status: 403 });
    }

    phase = 'params';
    const { id } = await params;
    const numericId = parseInt(id, 10);
    if (isNaN(numericId)) {
      return Response.json({ error: 'Invalid id', phase: 'params' }, { status: 400 });
    }

    phase = 'db-lookup';
    const row = getDb()
      .prepare<[number], { requested_permissions: string }>(
        'SELECT requested_permissions FROM permission_requests WHERE id = ?',
      )
      .get(numericId);
    if (!row) {
      return Response.json({ error: 'Permission request not found', phase: 'db-lookup' }, { status: 404 });
    }

    phase = 'db-approve';
    const permissions = JSON.parse(row.requested_permissions) as Permission[];
    approvePermissionRequest(numericId, permissions);

    console.log('[admin] action=approve-permission-request id=%d permissions=%s', numericId, JSON.stringify(permissions));
    return Response.json({ ok: true, message: 'Sign out and back in to activate new permissions' });
  } catch (err) {
    console.error('[admin] phase=%s error=%s', phase, String(err));
    return Response.json({ error: 'Internal server error', phase }, { status: 500 });
  }
}
