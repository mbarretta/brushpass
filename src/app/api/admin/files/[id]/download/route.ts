export const runtime = 'nodejs';

import { type NextRequest } from 'next/server';
import { getFileById } from '@/lib/db';
import { getIsAdmin } from '@/lib/admin-auth';
import { generateSignedDownloadUrl } from '@/lib/gcs';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params): Promise<Response> {
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
    const record = getFileById(numericId);
    if (!record) {
      return Response.json({ error: 'File not found', phase: 'db-lookup' }, { status: 404 });
    }

    phase = 'expiry-check';
    if (record.expires_at !== null && Math.floor(Date.now() / 1000) > record.expires_at) {
      return Response.json({ error: 'File has expired', phase: 'expiry-check' }, { status: 410 });
    }

    phase = 'sign-url';
    const url = await generateSignedDownloadUrl(
      record.gcs_key,
      record.original_name,
      record.content_type,
    );

    console.log('[admin] action=download-url id=%d gcs_key=%s', numericId, record.gcs_key);
    return Response.json({ url });
  } catch (err) {
    console.error('[admin] phase=%s error=%s', phase, String(err));
    return Response.json({ error: 'Internal server error', phase }, { status: 500 });
  }
}
