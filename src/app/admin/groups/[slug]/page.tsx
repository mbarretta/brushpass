import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { getGroupWithFiles, listFiles } from '@/lib/db';
import { getIsAdmin } from '@/lib/admin-auth';
import AdminGroupActions from './AdminGroupActions';
import GroupUpload from './GroupUpload';

export const metadata = { title: 'Admin — Group Detail' };

function formatUnix(unix: number | null): string {
  if (unix === null) return '—';
  return new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export default async function AdminGroupDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  if (!(await getIsAdmin())) {
    redirect('/login');
  }

  const { slug } = await params;
  const group = getGroupWithFiles(slug);
  if (!group) notFound();

  const allFiles = listFiles();
  const memberIds = new Set(group.files.map((f) => f.id));

  const publicUrl = `/g/${group.slug}`;

  const fields: [string, string][] = [
    ['Slug', group.slug],
    ['Public URL', publicUrl],
    ['Files', String(group.files.length)],
    ['Expires', formatUnix(group.expires_at)],
    ['Created by', group.created_by ?? '—'],
    ['Created at', formatUnix(group.created_at)],
  ];

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 px-4 py-10 pr-40">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <Link href="/admin/groups" className="text-sm text-zinc-500 hover:underline">
            ← File Groups
          </Link>
          <span className="text-zinc-300 dark:text-zinc-700">/</span>
          <span className="text-sm text-zinc-900 dark:text-zinc-100 font-medium">{group.name}</span>
        </div>

        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">{group.name}</h1>

        {/* Metadata card */}
        <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800">
          {fields.map(([label, value]) => (
            <div key={label} className="px-5 py-3 text-sm">
              <p className="text-zinc-500 dark:text-zinc-400 text-xs mb-0.5">{label}</p>
              {label === 'Public URL' ? (
                <Link
                  href={value}
                  target="_blank"
                  className="text-blue-600 dark:text-blue-400 hover:underline font-mono text-sm"
                >
                  {value}
                </Link>
              ) : (
                <p className="text-zinc-900 dark:text-zinc-100 font-mono break-all">{value}</p>
              )}
            </div>
          ))}
        </div>

        {/* Upload directly to group */}
        <GroupUpload slug={group.slug} />

        {/* Actions: rename, manage files, delete */}
        <AdminGroupActions
          slug={group.slug}
          name={group.name}
          allFiles={allFiles}
          memberIds={memberIds}
        />
      </div>
    </div>
  );
}
