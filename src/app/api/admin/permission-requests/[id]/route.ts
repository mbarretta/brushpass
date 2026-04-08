export const runtime = 'nodejs';

import { type NextRequest } from 'next/server';
import { getIsAdmin } from '@/lib/admin-auth';
import { getDb, denyPermissionRequest } from '@/lib/db';

type Params = { params: Promise<{ id: string }> };

export async function DELETE(_request: NextRequest, { params }: Params): Promise<Response> {
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
      .prepare<[number], { id: number }>('SELECT id FROM permission_requests WHERE id = ?')
      .get(numericId);
    if (!row) {
      return Response.json({ error: 'Permission request not found', phase: 'db-lookup' }, { status: 404 });
    }

    phase = 'db-deny';
    denyPermissionRequest(numericId);

    console.log('[admin] action=deny-permission-request id=%d', numericId);
    return Response.json({ ok: true });
  } catch (err) {
    console.error('[admin] phase=%s error=%s', phase, String(err));
    return Response.json({ error: 'Internal server error', phase }, { status: 500 });
  }
}
