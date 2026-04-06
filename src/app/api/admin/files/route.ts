export const runtime = 'nodejs';

import { type NextRequest } from 'next/server';
import { listFiles, getFileById, deleteFile } from '@/lib/db';
import { getIsAdmin } from '@/lib/admin-auth';
import { deleteFromGCS } from '@/lib/gcs';

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

export async function DELETE(request: NextRequest): Promise<Response> {
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

    const { ids } = body as Record<string, unknown>;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      !ids.every((v) => typeof v === 'number')
    ) {
      return Response.json(
        { error: 'ids must be a non-empty array of numbers', phase: 'body-parse' },
        { status: 400 },
      );
    }

    phase = 'bulk-delete';
    const results: { id: number; ok: boolean; error?: string }[] = [];

    for (const id of ids as number[]) {
      const record = getFileById(id);
      if (!record) {
        results.push({ id, ok: false, error: 'File not found' });
        continue;
      }

      try {
        await deleteFromGCS(record.gcs_key);
      } catch (err) {
        const msg = String(err);
        console.error('[admin] phase=gcs-delete error=%s id=%d', msg, id);
        results.push({ id, ok: false, error: msg });
        continue;
      }

      deleteFile(id);
      results.push({ id, ok: true });
    }

    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.length - okCount;
    console.log(
      '[admin] action=bulk-delete count=%d ok=%d fail=%d',
      results.length,
      okCount,
      failCount,
    );

    return Response.json({ results });
  } catch (err) {
    console.error('[admin] phase=%s error=%s', phase, String(err));
    return Response.json({ error: 'Internal server error', phase }, { status: 500 });
  }
}
