import { redirect } from 'next/navigation';
import { getIsAdmin } from '@/lib/admin-auth';
import AdminUserNew from './AdminUserNew';

export const metadata = { title: 'Admin — New User' };

export default async function AdminUserNewPage() {
  if (!(await getIsAdmin())) {
    redirect('/login');
  }

  return <AdminUserNew />;
}
