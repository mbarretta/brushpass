export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { getExpiredFiles, deleteFile } from '@/lib/db';
import { deleteFromGCS } from '@/lib/gcs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CLEANUP_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (token !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const expired = getExpiredFiles();
  let deleted = 0;
  const errors: string[] = [];

  for (const record of expired) {
    try {
      await deleteFromGCS(record.gcs_key);
      deleteFile(record.id);
      deleted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[cleanup] phase=gcs-delete key=%s error=%s', record.gcs_key, msg);
      errors.push(`${record.gcs_key}: ${msg}`);
    }
  }

  console.log('[cleanup] deleted=%d errors=%d', deleted, errors.length);
  return NextResponse.json({ deleted, errors });
}
