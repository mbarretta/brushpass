export const runtime = 'nodejs';

import { timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { OAuth2Client } from 'google-auth-library';
import {
  getExpiredFiles,
  deleteFile,
  getExpiredDeviceSessions,
  deleteDeviceSession,
} from '@/lib/db';
import type { FileRecord } from '@/types';
import { deleteFromGCS } from '@/lib/gcs';

const oidcClient = new OAuth2Client();

// CLEANUP_AUDIENCE pins the scheduler audience independently of AUTH_URL;
// AUTH_URL (the Cloud Run service's own URI) remains the fallback for
// deployments that have not set CLEANUP_AUDIENCE explicitly yet. Read fresh
// on every call rather than cached at module load, matching src/lib/agent-key.ts.
function getOidcAudience(): string {
  return process.env.CLEANUP_AUDIENCE ?? process.env.AUTH_URL ?? '';
}

function getSchedulerSa(): string {
  return process.env.CLEANUP_SCHEDULER_SA ?? '';
}

// Fails closed: an unset audience or scheduler SA must never silently
// disable the identity check (previously, an unset SCHEDULER_SA skipped the
// email comparison entirely and any token that merely verified was accepted).
async function verifyOidcToken(token: string): Promise<boolean> {
  const audience = getOidcAudience();
  const schedulerSa = getSchedulerSa();
  if (!audience || !schedulerSa) return false;
  try {
    const ticket = await oidcClient.verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload();
    if (!payload) return false;
    return payload.email === schedulerSa;
  } catch {
    return false;
  }
}

type CleanupResult = { ok: true } | { ok: false; error: string };

async function cleanupExpiredFile(record: FileRecord): Promise<CleanupResult> {
  try {
    await deleteFromGCS(record.gcs_key);
  } catch (err) {
    const code = (err as { code?: number } | null)?.code;
    if (code !== 404) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[cleanup] phase=gcs-delete key=%s error=%s', record.gcs_key, msg);
      return { ok: false, error: `${record.gcs_key}: ${msg}` };
    }
    // The object is already gone from GCS — fall through and remove the row
    // so a permanently-missing object isn't retried every hour forever.
  }
  deleteFile(record.id);
  return { ok: true };
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
    timingSafeEqual(tokenBuf, secretBuf);

  if (!secretMatch && !(await verifyOidcToken(token))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const expired = getExpiredFiles();
  const results = await Promise.all(expired.map(cleanupExpiredFile));

  let deleted = 0;
  const errors: string[] = [];
  for (const result of results) {
    if (result.ok) {
      deleted++;
    } else {
      errors.push(result.error);
    }
  }

  // Give getExpiredDeviceSessions/deleteDeviceSession their first production
  // caller: TTL-prune the brokered device-grant sessions in the same pass.
  const expiredSessions = getExpiredDeviceSessions();
  for (const session of expiredSessions) {
    deleteDeviceSession(session.poll_token_hash);
  }

  console.log(
    '[cleanup] deleted=%d errors=%d device_sessions_pruned=%d',
    deleted,
    errors.length,
    expiredSessions.length,
  );
  return NextResponse.json({ deleted, errors, deviceSessionsPruned: expiredSessions.length });
}
