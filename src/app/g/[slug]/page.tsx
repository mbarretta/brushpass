import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getGroupWithFiles } from '@/lib/db';
import GroupPage from './GroupPage';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const group = getGroupWithFiles(slug);
  if (!group) return { title: 'Group Not Found' };
  return { title: group.name };
}

export default async function GroupPublicPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const group = getGroupWithFiles(slug);

  if (!group) {
    notFound();
  }

  // Expired groups show a simple message rather than 404 — the slug is valid
  if (group.expires_at !== null && Math.floor(Date.now() / 1000) > group.expires_at) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 flex items-center justify-center px-4">
        <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-8 text-center max-w-sm w-full">
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
            Group Expired
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            This file group is no longer available.
          </p>
        </div>
      </div>
    );
  }

  return <GroupPage group={group} slug={slug} />;
}
