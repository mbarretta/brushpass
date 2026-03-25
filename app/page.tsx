import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/auth';

export const metadata = { title: 'Secure File Share' };

export default async function HomePage() {
  const session = await auth();
  if (session) {
    redirect('/upload');
  }

  return (
    <main className="min-h-screen bg-zinc-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-zinc-200 p-10 flex flex-col items-center text-center gap-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-zinc-900">Secure File Share</h1>
          <p className="text-sm text-zinc-500">
            Upload files. Share securely. Expire automatically.
          </p>
        </div>

        <Link
          href="/login"
          className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors text-center focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          Sign In
        </Link>
      </div>
    </main>
  );
}
