export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { OAuth2Client } from 'google-auth-library';
import { getExpiredFiles, deleteFile } from '@/lib/db';
import { deleteFromGCS } from '@/lib/gcs';

// The audience must match the Cloud Run service URI (no trailing slash).
// Set AUTH_URL in production; falls back to CLEANUP_AUDIENCE for local testing.
const OIDC_AUDIENCE = process.env.AUTH_URL ?? process.env.CLEANUP_AUDIENCE ?? '';
const SCHEDULER_SA = process.env.CLEANUP_SCHEDULER_SA ?? '';

const oidcClient = new OAuth2Client();

async function verifyOidcToken(token: string): Promise<boolean> {
  try {
    const ticket = await oidcClient.verifyIdToken({ idToken: token, audience: OIDC_AUDIENCE });
    const payload = ticket.getPayload();
    if (!payload) return false;
    // Verify the token was issued by the scheduler service account.
    if (SCHEDULER_SA && payload.email !== SCHEDULER_SA) return false;
    return true;
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Accept either a valid OIDC token from the scheduler SA (production)
  // or the CLEANUP_SECRET for local development / manual testing.
  const secret = process.env.CLEANUP_SECRET ?? '';
  const secretBuf = Buffer.from(secret);
  const tokenBuf = Buffer.from(token);
  const secretMatch =
    secret.length > 0 &&
    tokenBuf.length === secretBuf.length &&
    require('crypto').timingSafeEqual(tokenBuf, secretBuf);

  if (!secretMatch && !(await verifyOidcToken(token))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const expired = getExpiredFiles();
  const results = await Promise.allSettled(
    expired.map(async (record) => {
      await deleteFromGCS(record.gcs_key);
      deleteFile(record.id);
    }),
  );

  let deleted = 0;
  const errors: string[] = [];
  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      deleted++;
    } else {
      const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.error('[cleanup] phase=gcs-delete key=%s error=%s', expired[i].gcs_key, msg);
      errors.push(`${expired[i].gcs_key}: ${msg}`);
    }
  }

  console.log('[cleanup] deleted=%d errors=%d', deleted, errors.length);
  return NextResponse.json({ deleted, errors });
}
