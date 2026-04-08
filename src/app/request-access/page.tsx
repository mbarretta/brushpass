import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import RequestAccessForm from './RequestAccessForm';

export const metadata = { title: 'Request Access — Brushpass' };

export default async function RequestAccessPage() {
  const session = await auth();
  if (!session) redirect('/login');
  if ((session.user.permissions ?? []).length > 0) redirect('/upload');
  return <RequestAccessForm />;
}
