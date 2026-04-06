import { redirect } from 'next/navigation';
import { listFiles } from '@/lib/db';
import { getIsAdmin } from '@/lib/admin-auth';
import AdminFilesClient from './AdminFilesClient';

export const metadata = { title: 'Admin — Files' };

export default async function AdminFilesPage() {
  if (!(await getIsAdmin())) {
    redirect('/login');
  }

  const files = listFiles();

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 px-4 py-10 pr-40">
      <div className="max-w-5xl mx-auto">
        <AdminFilesClient files={files} />
      </div>
    </div>
  );
}
