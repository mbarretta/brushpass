import { redirect } from 'next/navigation';

export const metadata = { title: 'Download File' };

export default async function DownloadPage({
  params,
  searchParams,
}: {
  params: Promise<{ md5: string }>;
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { md5 } = await params;
  const { token, error } = await searchParams;

  // If token is present, redirect immediately to the download API
  if (token) {
    redirect('/api/download/' + md5 + '?token=' + encodeURIComponent(token));
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
            <form method="get" action={`/api/download/${md5}`} className="flex flex-col gap-3">
              <input
                name="token"
                type="text"
                placeholder="Paste token here"
                required
                autoFocus
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-4 py-2.5 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-200"
              />
              <button
                type="submit"
                className="w-full rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm font-medium py-2.5 hover:bg-zinc-700 dark:hover:bg-zinc-300 transition-colors"
              >
                Download
              </button>
            </form>
            <div className="mt-6 pt-5 border-t border-zinc-100 dark:border-zinc-800">
              <p className="text-xs text-zinc-400 dark:text-zinc-500 mb-1">File hash (MD5)</p>
              <p className="text-sm font-mono text-zinc-700 dark:text-zinc-300 break-all">{md5}</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
