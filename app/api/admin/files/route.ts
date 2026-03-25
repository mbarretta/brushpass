export const runtime = 'nodejs';

import { type NextRequest } from 'next/server';
import { listFiles } from '@/lib/db';
import { getIsAdmin } from '@/lib/admin-auth';

export async function GET(request: NextRequest): Promise<Response> {
  let phase = 'auth';
  try {
    if (!(await getIsAdmin())) {
      return Response.json({ error: 'Forbidden', phase: 'auth' }, { status: 403 });
    }

    phase = 'db-list';
    const files = listFiles();

    // Strip token_hash from every record before returning
    const safeFiles = files.map(({ token_hash: _th, ...rest }) => rest);

    console.log('[admin] action=list count=%d', safeFiles.length);
    return Response.json(safeFiles);
  } catch (err) {
    console.error('[admin] phase=%s error=%s', phase, String(err));
    return Response.json({ error: 'Internal server error', phase }, { status: 500 });
  }
}
