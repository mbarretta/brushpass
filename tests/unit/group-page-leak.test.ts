/**
 * Tests for /g/[slug]/page.tsx — the anonymous group landing page must never
 * receive (and therefore never serialize into the RSC payload / HTML) the
 * group's token_hash, its files' gcs_key, or the file manifest itself before
 * the token is verified server-side by POST /api/groups/[slug]/access.
 * Covers ac1, ac2, ac7.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const notFoundSpy = vi.fn(() => {
  throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_NOT_FOUND' });
});

vi.mock('next/navigation', () => ({
  notFound: notFoundSpy,
}));

// getGroupWithFiles / listGroupFiles are deliberately wired to throw: if the
// page is ever changed to call either of them again, that reintroduces the
// leak this task fixes (full manifest + token_hash serialized before the
// token gate) and this suite should fail loudly rather than silently pass.
vi.mock('@/lib/db', () => ({
  getGroupNameBySlug: vi.fn(),
  isValidSlug: vi.fn(),
  getGroupWithFiles: vi.fn(() => {
    throw new Error('getGroupWithFiles must not be called from the pre-token page');
  }),
  listGroupFiles: vi.fn(() => {
    throw new Error('listGroupFiles must not be called from the pre-token page');
  }),
}));

describe('/g/[slug]/page — anonymous pre-token page', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    notFoundSpy.mockImplementation(() => {
      throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_NOT_FOUND' });
    });
  });

  it('passes only { name, slug } to GroupPage — no group object, no files, no expiry, no secrets', async () => {
    const db = await import('@/lib/db');
    vi.mocked(db.isValidSlug).mockReturnValue(true);
    vi.mocked(db.getGroupNameBySlug).mockReturnValue({ name: 'Secret Group', expires_at: 1234567890 });

    const { default: GroupPublicPage } = await import('@/app/g/[slug]/page');
    const element = await GroupPublicPage({ params: Promise.resolve({ slug: 'test-group' }) });

    expect(Object.keys(element.props as object).sort()).toEqual(['name', 'slug']);
    expect((element.props as { name: string }).name).toBe('Secret Group');
    expect((element.props as { slug: string }).slug).toBe('test-group');
    expect(element.props).not.toHaveProperty('group');
    expect(element.props).not.toHaveProperty('files');
    expect(element.props).not.toHaveProperty('expires_at');
    const serialized = JSON.stringify(element.props);
    expect(serialized).not.toContain('$2b$');
    expect(serialized).not.toContain('gcs_key');
    expect(serialized).not.toContain('token_hash');
  });

  it('fetches only the name projection — getGroupNameBySlug — for the given slug', async () => {
    const db = await import('@/lib/db');
    vi.mocked(db.isValidSlug).mockReturnValue(true);
    vi.mocked(db.getGroupNameBySlug).mockReturnValue({ name: 'Secret Group', expires_at: null });

    const { default: GroupPublicPage } = await import('@/app/g/[slug]/page');
    await GroupPublicPage({ params: Promise.resolve({ slug: 'test-group' }) });

    expect(db.getGroupNameBySlug).toHaveBeenCalledWith('test-group');
    expect(db.getGroupNameBySlug).toHaveBeenCalledTimes(1);
  });

  it('calls notFound() for a slug that fails isValidSlug, without querying the DB', async () => {
    const db = await import('@/lib/db');
    vi.mocked(db.isValidSlug).mockReturnValue(false);

    const { default: GroupPublicPage } = await import('@/app/g/[slug]/page');
    await expect(
      GroupPublicPage({ params: Promise.resolve({ slug: '../../etc/passwd' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(db.getGroupNameBySlug).not.toHaveBeenCalled();
  });

  it('calls notFound() for an unknown but syntactically valid slug', async () => {
    const db = await import('@/lib/db');
    vi.mocked(db.isValidSlug).mockReturnValue(true);
    vi.mocked(db.getGroupNameBySlug).mockReturnValue(undefined);

    const { default: GroupPublicPage } = await import('@/app/g/[slug]/page');
    await expect(
      GroupPublicPage({ params: Promise.resolve({ slug: 'no-such-group' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
