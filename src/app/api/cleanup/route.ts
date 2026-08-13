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

// Both the async GCS delete and the synchronous DB row delete get their own
// try/catch, each returning the failure directly rather than throwing. Promise.all
// below requires every settled promise to resolve (never reject); letting either
// throw escape unhandled would reject the whole batch and turn one bad row into
// an unhandled 500 for the entire cleanup pass instead of one counted error. Two
// catches (rather than one wrapping both steps) also keeps the logged phase
// accurate — gcs-delete vs db-delete — for whichever step actually failed.
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

  try {
    deleteFile(record.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[cleanup] phase=db-delete key=%s error=%s', record.gcs_key, msg);
    return { ok: false, error: `${record.gcs_key}: ${msg}` };
  }

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

  // Give getExpiredDeviceSessions its first production caller (deleteDeviceSession
  // already has 11 call sites in the token-poll route): TTL-prune the brokered
  // device-grant sessions in the same pass. Each deletion is isolated in its own
  // try/catch — same reasoning as cleanupExpiredFile above — so one bad row can't
  // throw the whole handler into an unhandled 500.
  const expiredSessions = getExpiredDeviceSessions();
  let sessionsPruned = 0;
  for (const session of expiredSessions) {
    try {
      deleteDeviceSession(session.poll_token_hash);
      sessionsPruned++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        '[cleanup] phase=device-session-prune hash=%s error=%s',
        session.poll_token_hash,
        msg,
      );
      errors.push(`device-session ${session.poll_token_hash}: ${msg}`);
    }
  }

  console.log(
    '[cleanup] deleted=%d errors=%d device_sessions_pruned=%d',
    deleted,
    errors.length,
    sessionsPruned,
  );
  return NextResponse.json({ deleted, errors, deviceSessionsPruned: sessionsPruned });
}
