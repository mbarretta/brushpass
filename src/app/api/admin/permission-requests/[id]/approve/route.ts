export const runtime = 'nodejs';

import { type NextRequest } from 'next/server';
import { getIsAdmin, isValidPermissionsArray } from '@/lib/admin-auth';
import { parseId } from '@/lib/http';
import { getDb, approvePermissionRequest } from '@/lib/db';
import type { Permission } from '@/types';

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params): Promise<Response> {
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

    // An admin-supplied `permissions` override is optional — an empty or
    // absent body falls back to the originally requested set below. This is
    // what lets an admin consciously grant a narrower (or wider) set than
    // what was requested, rather than rubber-stamping it.
    phase = 'body-parse';
    let permissionsOverride: unknown;
    const rawBody = await request.text();
    if (rawBody) {
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        return Response.json({ error: 'Invalid JSON body', phase }, { status: 400 });
      }
      permissionsOverride = (parsedBody as Record<string, unknown> | null)?.permissions;
      if (permissionsOverride !== undefined && !isValidPermissionsArray(permissionsOverride)) {
        return Response.json(
          { error: 'permissions contains invalid values; allowed: upload, admin', phase },
          { status: 400 },
        );
      }
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
    const requestedPermissions = JSON.parse(row.requested_permissions) as Permission[];
    const grantedPermissions = isValidPermissionsArray(permissionsOverride)
      ? permissionsOverride
      : requestedPermissions;
    approvePermissionRequest(numericId, grantedPermissions);

    console.log(
      '[admin] action=approve-permission-request id=%d permissions=%s',
      numericId,
      JSON.stringify(grantedPermissions),
    );
    return Response.json({ ok: true, message: 'Sign out and back in to activate new permissions' });
  } catch (err) {
    console.error('[admin] phase=%s error=%s', phase, String(err));
    return Response.json({ error: 'Internal server error', phase }, { status: 500 });
  }
}
