import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { getUserById } from '@/lib/db';
import AccountForm from './AccountForm';

export const metadata = { title: 'Account — Brushpass' };

export default async function AccountPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login');

  const userId = parseInt(session.user.id, 10);
  const dbUser = getUserById(userId);
  if (!dbUser) redirect('/login');

  return (
    <AccountForm
      username={dbUser.username}
      authProvider={dbUser.auth_provider}
      email={dbUser.email ?? null}
      permissions={dbUser.permissions}
    />
  );
}
