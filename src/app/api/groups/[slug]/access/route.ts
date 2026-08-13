export const runtime = 'nodejs';

import { type NextRequest } from 'next/server';
import { getGroupBySlugForAuth, listGroupFiles, isValidSlug } from '@/lib/db';
import { verifySecret } from '@/lib/token';
import type { PublicGroupFile } from '@/types';

type Params = { params: Promise<{ slug: string }> };

export async function POST(request: NextRequest, { params }: Params): Promise<Response> {
  let phase = 'params';
  try {
    const { slug } = await params;

    phase = 'body-parse';
    const body: unknown = await request.json().catch(() => null);
    const token =
      typeof body === 'object' && body !== null && 'token' in body && typeof (body as { token: unknown }).token === 'string'
        ? (body as { token: string }).token
        : '';

    // Look the group up only for a syntactically valid slug, but always run
    // the same single bcrypt compare below regardless: verifySecret compares
    // against a fixed dummy hash of the same cost when there is no group, so an
    // unknown slug and a wrong token are neither an existence nor a timing
    // oracle.
    phase = 'db-lookup';
    const group = isValidSlug(slug) ? getGroupBySlugForAuth(slug) : undefined;

    phase = 'token-verify';
    const valid = await verifySecret(token, group?.token_hash ?? null);
    if (!group || !valid) {
      // Log the rejection server-side so a guessing campaign leaves a trace
      // (every sibling secret-verifying route does the same). The response
      // body must stay byte-identical for both branches — the slug/outcome
      // distinction lives only in this log line, never in the response.
      // JSON.stringify the slug: it is attacker-controlled and unvalidated on
      // this branch, and a raw %0A would otherwise forge log lines.
      console.warn(
        '[group-access] phase=token-verify slug=%s result=%s',
        JSON.stringify(slug),
        group ? 'invalid_token' : 'unknown_slug',
      );
      return Response.json({ error: 'Invalid token' }, { status: 401 });
    }

    // Expiry is only revealed once the caller has proven they hold a valid
    // token — the pre-token page (task's page.tsx) must not leak it.
    phase = 'expiry-check';
    if (group.expires_at !== null && Math.floor(Date.now() / 1000) > group.expires_at) {
      return Response.json({ error: 'Group has expired', phase: 'expiry-check' }, { status: 410 });
    }

    phase = 'file-lookup';
    const now = Math.floor(Date.now() / 1000);
    // Same "not yet strictly past expiry" boundary as the group-download
    // route's per-file check, so a file expiring in the same second is
    // treated identically by both (included, not yet expired) in each.
    const files: PublicGroupFile[] = listGroupFiles(group.id)
      .filter((f) => f.expires_at === null || now <= f.expires_at)
      .map((f) => ({
        sha256: f.sha256,
        original_name: f.original_name,
        size: f.size,
        content_type: f.content_type,
      }));

    return Response.json({ name: group.name, expires_at: group.expires_at, files });
  } catch (err) {
    console.error('[group-access] phase=%s error=%s', phase, String(err));
    return Response.json({ error: 'Internal server error', phase }, { status: 500 });
  }
}
