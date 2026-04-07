export const runtime = 'nodejs';

import { type NextRequest } from 'next/server';
import { getGroupBySlug, listGroupFiles, updateGroup, deleteGroup, isValidSlug } from '@/lib/db';
import { getIsAdmin } from '@/lib/admin-auth';
import { generateToken, hashToken } from '@/lib/token';

type Params = { params: Promise<{ slug: string }> };

export async function GET(_request: NextRequest, { params }: Params): Promise<Response> {
  let phase = 'auth';
  try {
    if (!(await getIsAdmin())) {
      return Response.json({ error: 'Forbidden', phase: 'auth' }, { status: 403 });
    }

    phase = 'params';
    const { slug } = await params;

    phase = 'db-lookup';
    const group = getGroupBySlug(slug);
    if (!group) {
      return Response.json({ error: 'Group not found', phase: 'db-lookup' }, { status: 404 });
    }

    const files = listGroupFiles(group.id);
    return Response.json({ ...group, files });
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
    const { slug } = await params;

    phase = 'db-lookup';
    const group = getGroupBySlug(slug);
    if (!group) {
      return Response.json({ error: 'Group not found', phase: 'db-lookup' }, { status: 404 });
    }

    phase = 'body-parse';
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body', phase: 'body-parse' }, { status: 400 });
    }

    const { name, slug: newSlug, expires_at } = body as Record<string, unknown>;
    const patch: { name?: string; slug?: string; expires_at?: number | null } = {};

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return Response.json({ error: 'name must be a non-empty string', phase: 'body-parse' }, { status: 400 });
      }
      patch.name = name.trim();
    }
    if (newSlug !== undefined) {
      if (typeof newSlug !== 'string' || !isValidSlug(newSlug)) {
        return Response.json(
          { error: 'slug must be lowercase alphanumeric and hyphens, 1–64 chars', phase: 'body-parse' },
          { status: 400 },
        );
      }
      patch.slug = newSlug;
    }
    if ('expires_at' in (body as object)) {
      patch.expires_at = expires_at === null ? null : (typeof expires_at === 'number' ? expires_at : null);
    }

    phase = 'db-update';
    updateGroup(group.id, patch);

    console.log('[admin] action=update-group slug=%s', slug);
    return Response.json({ ok: true });
  } catch (err) {
    console.error('[admin] phase=%s error=%s', phase, String(err));
    if (String(err).includes('UNIQUE constraint failed')) {
      return Response.json({ error: 'Slug already exists', phase }, { status: 409 });
    }
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
    const { slug } = await params;

    phase = 'db-lookup';
    const group = getGroupBySlug(slug);
    if (!group) {
      return Response.json({ error: 'Group not found', phase: 'db-lookup' }, { status: 404 });
    }

    phase = 'token-gen';
    const token = generateToken();
    const hash = await hashToken(token);

    phase = 'db-update';
    updateGroup(group.id, { token_hash: hash });

    console.log('[admin] action=regenerate-group-token slug=%s', slug);
    return Response.json({ token });
  } catch (err) {
    console.error('[admin] phase=%s error=%s', phase, String(err));
    return Response.json({ error: 'Internal server error', phase }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, { params }: Params): Promise<Response> {
  let phase = 'auth';
  try {
    if (!(await getIsAdmin())) {
      return Response.json({ error: 'Forbidden', phase: 'auth' }, { status: 403 });
    }

    phase = 'params';
    const { slug } = await params;

    phase = 'db-lookup';
    const group = getGroupBySlug(slug);
    if (!group) {
      return Response.json({ error: 'Group not found', phase: 'db-lookup' }, { status: 404 });
    }

    phase = 'db-delete';
    deleteGroup(group.id);

    console.log('[admin] action=delete-group slug=%s', slug);
    return Response.json({ ok: true });
  } catch (err) {
    console.error('[admin] phase=%s error=%s', phase, String(err));
    return Response.json({ error: 'Internal server error', phase }, { status: 500 });
  }
}
