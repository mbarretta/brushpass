export const runtime = 'nodejs';

import { type NextRequest } from 'next/server';
import { getFileById, getDownloadLogs, updateFileExpiry, updateFileTokenHash, deleteFile } from '@/lib/db';
import { getIsAdmin } from '@/lib/admin-auth';
import { parseId, readJson } from '@/lib/http';
import { generateToken, hashToken } from '@/lib/token';
import { deleteFromGCS } from '@/lib/gcs';

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
    const record = getFileById(numericId);
    if (!record) {
      return Response.json({ error: 'File not found', phase: 'db-lookup' }, { status: 404 });
    }

    phase = 'db-metrics';
    const download_logs = getDownloadLogs(numericId);

    // getFileById() already projects out token_hash — no strip needed.
    console.log('[admin] action=get id=%d download_count=%d', numericId, download_logs.length);
    return Response.json({ ...record, download_count: download_logs.length, download_logs });
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

    const { expires_at } = parsed.body as Record<string, unknown>;
    if (expires_at !== null && typeof expires_at !== 'number') {
      return Response.json(
        { error: 'expires_at must be a number or null', phase: 'body-parse' },
        { status: 400 },
      );
    }

    phase = 'db-update';
    updateFileExpiry(numericId, expires_at as number | null);

    console.log('[admin] action=patch id=%d expires_at=%s', numericId, expires_at);
    return Response.json({ ok: true });
  } catch (err) {
    console.error('[admin] phase=%s error=%s', phase, String(err));
    return Response.json({ error: 'Internal server error', phase }, { status: 500 });
  }
}

export async function POST(_request: NextRequest, { params }: Params): Promise<Response> {
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
    const record = getFileById(numericId);
    if (!record) {
      return Response.json({ error: 'File not found', phase: 'db-lookup' }, { status: 404 });
    }

    phase = 'token-gen';
    const token = generateToken();
    const hash = await hashToken(token);

    phase = 'db-update';
    updateFileTokenHash(numericId, hash);

    console.log('[admin] action=regenerate-token id=%d', numericId);
    return Response.json({ token });
  } catch (err) {
    console.error('[admin] phase=%s error=%s', phase, String(err));
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

    phase = 'db-lookup';
    const record = getFileById(numericId);
    if (!record) {
      return Response.json({ error: 'File not found', phase: 'db-lookup' }, { status: 404 });
    }

    phase = 'gcs-delete';
    try {
      await deleteFromGCS(record.gcs_key);
    } catch (err) {
      console.error('[admin] phase=%s error=%s id=%d', 'gcs-delete', String(err), numericId);
      return Response.json({ error: 'GCS delete failed', phase: 'gcs-delete' }, { status: 500 });
    }

    phase = 'db-delete';
    deleteFile(numericId);

    console.log('[admin] action=delete id=%d', numericId);
    return Response.json({ ok: true });
  } catch (err) {
    console.error('[admin] phase=%s error=%s', phase, String(err));
    return Response.json({ error: 'Internal server error', phase }, { status: 500 });
  }
}
