import { redirect, notFound } from 'next/navigation';
import { isValidSha256 } from '@/lib/sha256';
import TokenForm from './TokenForm';

export const metadata = { title: 'Download File' };

export default async function DownloadPage({
  params,
  searchParams,
}: {
  params: Promise<{ sha256: string }>;
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { sha256 } = await params;

  if (!isValidSha256(sha256)) {
    notFound();
  }

  const { token, error } = await searchParams;

  // Already-shared links of the form /<sha256>?token=... keep working. No new
  // exposure is created by forwarding: the token is already in this request's
  // own URL by the time we see it. Links created from here on carry no token —
  // TokenForm below POSTs it instead.
  if (token) {
    redirect('/api/download/' + sha256 + '?token=' + encodeURIComponent(token));
  }

  const isExpired = error === 'expired';

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-8">
        {isExpired ? (
          <>
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 mb-3">
              File Unavailable
            </h1>
            <p className="text-zinc-500 dark:text-zinc-400 text-sm">
              This file has expired and is no longer available.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
              Enter download token
            </h1>
            <p className="text-zinc-500 dark:text-zinc-400 text-sm mb-6">
              Paste the token you received when this file was uploaded.
            </p>
            <TokenForm sha256={sha256} />
            <div className="mt-6 pt-5 border-t border-zinc-100 dark:border-zinc-800">
              <p className="text-xs text-zinc-400 dark:text-zinc-500 mb-1">File hash (SHA-256)</p>
              <p className="text-sm font-mono text-zinc-700 dark:text-zinc-300 break-all">{sha256}</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
