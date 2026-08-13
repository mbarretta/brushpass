export const runtime = 'nodejs';

import { type NextRequest } from 'next/server';
import { listFiles, getFileById, deleteFile, getFileBySha256 } from '@/lib/db';
import { getIsAdmin } from '@/lib/admin-auth';
import { deleteFromGCS } from '@/lib/gcs';

export async function GET(request: NextRequest): Promise<Response> {
  let phase = 'auth';
  try {
    if (!(await getIsAdmin())) {
      return Response.json({ error: 'Forbidden', phase: 'auth' }, { status: 403 });
    }

    phase = 'db-list';
    const sha256Param = new URL(request.url).searchParams.get('sha256');

    if (sha256Param) {
      // Single-file lookup by sha256 — used by group upload collision path.
      // getFileBySha256() already projects out token_hash — no strip needed.
      const file = getFileBySha256(sha256Param);
      if (!file) return Response.json({ error: 'File not found' }, { status: 404 });
      return Response.json(file);
    }

    // listFiles() already projects out token_hash — no strip needed.
    const files = listFiles();

    console.log('[admin] action=list count=%d', files.length);
    return Response.json(files);
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
    if ((ids as number[]).length > 100) {
      return Response.json(
        { error: 'Maximum 100 ids per request', phase: 'body-parse' },
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
