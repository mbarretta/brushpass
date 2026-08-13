export const runtime = 'nodejs';

import { type NextRequest } from 'next/server';
import { getGroupBySlugForAuth, listGroupFiles, isValidSlug } from '@/lib/db';
import { verifyToken } from '@/lib/token';
import type { PublicGroupFile } from '@/types';

type Params = { params: Promise<{ slug: string }> };

// A fixed, valid-format bcrypt hash (cost 10, matching hashToken) with no
// known matching plaintext. Comparing against it when the slug does not
// resolve to a group means an unknown slug and a wrong token both perform
// exactly one bcrypt compare of the same cost — the route is neither an
// existence oracle nor a timing oracle. Kept local rather than lifted into a
// shared src/lib/token.ts helper because token.ts is also owned by task 7
// this wave; a later pass can centralize this as verifySecret().
const DUMMY_HASH = '$2b$10$ldoR1kAaaHJshR1Lfj/HMuI/unzyO2gkzXkRpddg5simrk5FUP9HG';

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
    // the same single bcrypt compare below regardless — see DUMMY_HASH.
    phase = 'db-lookup';
    const group = isValidSlug(slug) ? getGroupBySlugForAuth(slug) : undefined;

    phase = 'token-verify';
    const valid = await verifyToken(token, group?.token_hash ?? DUMMY_HASH);
    if (!group || !valid) {
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
