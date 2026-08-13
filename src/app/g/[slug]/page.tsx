import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getGroupNameBySlug, isValidSlug } from '@/lib/db';
import GroupPage from './GroupPage';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  if (!isValidSlug(slug)) return { title: 'Group Not Found' };
  const group = getGroupNameBySlug(slug);
  if (!group) return { title: 'Group Not Found' };
  return { title: group.name };
}

// Per the owner's decision, the pre-token page shows the group name only —
// no file count, no expiry, no listing. Everything else (expiry status, the
// file manifest) is only revealed by POST /api/groups/[slug]/access after
// the caller proves they hold the group's token. This page therefore never
// fetches getGroupWithFiles, so there is no group data to leak into the RSC
// payload before the token gate.
export default async function GroupPublicPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  if (!isValidSlug(slug)) {
    notFound();
  }

  const group = getGroupNameBySlug(slug);
  if (!group) {
    notFound();
  }

  return <GroupPage name={group.name} slug={slug} />;
}
