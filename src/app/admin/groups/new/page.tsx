import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getIsAdmin } from '@/lib/admin-auth';
import AdminGroupNew from './AdminGroupNew';

export const metadata = { title: 'Admin — New Group' };

export default async function AdminGroupNewPage() {
  if (!(await getIsAdmin())) {
    redirect('/login');
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 px-4 py-10 pr-40">
      <div className="max-w-md mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/admin/groups" className="text-sm text-zinc-500 hover:underline">
            ← File Groups
          </Link>
        </div>
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mb-6">New Group</h1>
        <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-8">
          <AdminGroupNew />
        </div>
      </div>
    </div>
  );
}
