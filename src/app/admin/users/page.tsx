import { redirect } from 'next/navigation';
import Link from 'next/link';
import { listUsers } from '@/lib/db';
import { getIsAdmin } from '@/lib/admin-auth';

export const metadata = { title: 'Admin — Users' };

export default async function AdminUsersPage() {
  if (!(await getIsAdmin())) {
    redirect('/login');
  }

  const users = listUsers();

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 px-4 py-10">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <Link href="/admin" className="text-sm text-zinc-500 hover:underline">
              ← Admin
            </Link>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mt-1">
              Users
            </h1>
          </div>
          <Link
            href="/admin/users/new"
            className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm font-medium px-4 py-2 hover:bg-zinc-700 dark:hover:bg-zinc-300 transition-colors"
          >
            New User
          </Link>
        </div>

        {users.length === 0 ? (
          <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-8 text-center text-zinc-400 text-sm">
            No users yet.
          </div>
        ) : (
          <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800">
                  <th className="text-left px-5 py-3 text-zinc-500 dark:text-zinc-400 font-medium">
                    Username
                  </th>
                  <th className="text-left px-5 py-3 text-zinc-500 dark:text-zinc-400 font-medium">
                    Permissions
                  </th>
                  <th className="text-left px-5 py-3 text-zinc-500 dark:text-zinc-400 font-medium">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr
                    key={user.id}
                    className="border-b border-zinc-100 dark:border-zinc-800 last:border-0 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                  >
                    <td className="px-5 py-3">
                      <Link
                        href={`/admin/users/${user.id}`}
                        className="text-zinc-900 dark:text-zinc-100 hover:underline font-medium"
                      >
                        {user.username}
                      </Link>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap gap-1">
                        {user.permissions.length === 0 ? (
                          <span className="text-zinc-400 text-xs">none</span>
                        ) : (
                          user.permissions.map((p) => (
                            <span
                              key={p}
                              className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300"
                            >
                              {p}
                            </span>
                          ))
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-zinc-500 dark:text-zinc-400">
                      {new Date(user.created_at * 1000).toISOString().replace('T', ' ').slice(0, 10)}
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
