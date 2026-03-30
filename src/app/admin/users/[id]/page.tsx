import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getUserById } from '@/lib/db';
import { getIsAdmin } from '@/lib/admin-auth';
import AdminUserActions from './AdminUserActions';

export const metadata = { title: 'Admin — User Detail' };

function formatUnix(unix: number): string {
  return new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!(await getIsAdmin())) {
    redirect('/login');
  }

  const { id } = await params;
  const numericId = parseInt(id, 10);

  if (isNaN(numericId)) {
    notFound();
  }

  const user = getUserById(numericId);

  if (!user) {
    notFound();
  }

  // Never render password_hash
  const { password_hash: _ph, ...safeUser } = user;

  const fields: [string, string][] = [
    ['ID', String(safeUser.id)],
    ['Username', safeUser.username],
    ['Permissions', safeUser.permissions.join(', ') || 'none'],
    ['Created', formatUnix(safeUser.created_at)],
  ];

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 px-4 py-10">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <Link href="/admin/users" className="text-sm text-zinc-500 hover:underline">
            ← Users
          </Link>
          <span className="text-zinc-300 dark:text-zinc-700">/</span>
          <span className="text-sm text-zinc-900 dark:text-zinc-100 font-medium">
            {safeUser.username}
          </span>
        </div>

        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
          User Detail
        </h1>

        {/* Metadata card */}
        <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800">
          {fields.map(([label, value]) => (
            <div
              key={label}
              className="flex justify-between items-baseline px-5 py-3 text-sm gap-4"
            >
              <span className="text-zinc-500 dark:text-zinc-400 shrink-0">{label}</span>
              <span className="text-zinc-900 dark:text-zinc-100 font-mono text-right break-all">
                {value}
              </span>
            </div>
          ))}
        </div>

        {/* Mutations (client component) */}
        <AdminUserActions
          userId={safeUser.id}
          username={safeUser.username}
          permissions={safeUser.permissions}
        />
      </div>
    </div>
  );
}
