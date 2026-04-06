'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function DownloadForm() {
  const [hash, setHash] = useState('');
  const [token, setToken] = useState('');
  const router = useRouter();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const h = hash.trim();
    const tok = token.trim();
    if (!h) return;
    // Navigate to the per-file download page, which handles the token
    const url = tok
      ? `/${h}?token=${encodeURIComponent(tok)}`
      : `/${h}`;
    router.push(url);
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-8">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mb-2 text-center">Download a file</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center mb-8">
          Enter the file hash and token you received at upload time.
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="hash" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              File hash (SHA-256) <span className="text-red-500">*</span>
            </label>
            <input
              id="hash"
              type="text"
              required
              value={hash}
              onChange={(e) => setHash(e.target.value)}
              placeholder="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
              autoFocus
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-4 py-2.5 text-sm font-mono text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-200"
            />
          </div>

          <div>
            <label htmlFor="token" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Token <span className="text-red-500">*</span>
            </label>
            <input
              id="token"
              type="text"
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste your download token"
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-4 py-2.5 text-sm font-mono text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-200"
            />
          </div>

          <button
            type="submit"
            disabled={!hash.trim() || !token.trim()}
            className="w-full rounded-lg bg-zinc-900 dark:bg-zinc-100 px-4 py-2.5 text-sm font-medium text-white dark:text-zinc-900 hover:bg-zinc-700 dark:hover:bg-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2"
          >
            Download
          </button>
        </form>
      </div>
    </div>
  );
}
