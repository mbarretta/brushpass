import { redirect } from 'next/navigation';
import Link from 'next/link';
import { listGroups } from '@/lib/db';
import { getIsAdmin } from '@/lib/admin-auth';

export const metadata = { title: 'Admin — File Groups' };

function formatUnix(unix: number | null): string {
  if (unix === null) return '—';
  return new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 10);
}

export default async function AdminGroupsPage() {
  if (!(await getIsAdmin())) {
    redirect('/login');
  }

  const groups = listGroups();

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 px-4 py-10 pr-40">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">File Groups</h1>
          <Link
            href="/admin/groups/new"
            className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm font-medium px-4 py-2 hover:bg-zinc-700 dark:hover:bg-zinc-300 transition-colors"
          >
            New Group
          </Link>
        </div>

        {groups.length === 0 ? (
          <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-8 text-center text-zinc-400 text-sm">
            No groups yet.
          </div>
        ) : (
          <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800">
                  <th className="text-left px-5 py-3 text-zinc-500 dark:text-zinc-400 font-medium">Name</th>
                  <th className="text-left px-5 py-3 text-zinc-500 dark:text-zinc-400 font-medium">Slug</th>
                  <th className="text-left px-5 py-3 text-zinc-500 dark:text-zinc-400 font-medium">Files</th>
                  <th className="text-left px-5 py-3 text-zinc-500 dark:text-zinc-400 font-medium">Expires</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr
                    key={group.id}
                    className="border-b border-zinc-50 dark:border-zinc-800/50 last:border-0 hover:bg-zinc-50 dark:hover:bg-zinc-800/30 transition-colors"
                  >
                    <td className="px-5 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                      <Link
                        href={`/admin/groups/${group.slug}`}
                        className="hover:underline"
                      >
                        {group.name}
                      </Link>
                    </td>
                    <td className="px-5 py-3 font-mono text-zinc-500 dark:text-zinc-400 text-xs">
                      {group.slug}
                    </td>
                    <td className="px-5 py-3 text-zinc-600 dark:text-zinc-300">
                      {group.member_count}
                    </td>
                    <td className="px-5 py-3 text-zinc-500 dark:text-zinc-400">
                      {formatUnix(group.expires_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
