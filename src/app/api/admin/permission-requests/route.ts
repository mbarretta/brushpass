export const runtime = 'nodejs';

import { type NextRequest } from 'next/server';
import { getIsAdmin } from '@/lib/admin-auth';
import { listPendingPermissionRequests } from '@/lib/db';

export async function GET(_request: NextRequest): Promise<Response> {
  let phase = 'auth';
  try {
    if (!(await getIsAdmin())) {
      return Response.json({ error: 'Forbidden', phase: 'auth' }, { status: 403 });
    }

    phase = 'db-list';
    const requests = listPendingPermissionRequests();

    console.log('[admin] action=list-permission-requests count=%d', requests.length);
    return Response.json(requests);
  } catch (err) {
    console.error('[admin] phase=%s error=%s', phase, String(err));
    return Response.json({ error: 'Internal server error', phase }, { status: 500 });
  }
}
