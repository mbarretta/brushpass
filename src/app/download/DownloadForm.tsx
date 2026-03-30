'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function DownloadForm() {
  const [md5, setMd5] = useState('');
  const [token, setToken] = useState('');
  const router = useRouter();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const hash = md5.trim();
    const tok = token.trim();
    if (!hash) return;
    // Navigate to the per-file download page, which handles the token
    const url = tok
      ? `/${hash}?token=${encodeURIComponent(tok)}`
      : `/${hash}`;
    router.push(url);
  }

  return (
    <div className="min-h-screen bg-zinc-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-zinc-200 p-8">
        <h1 className="text-2xl font-semibold text-zinc-900 mb-2 text-center">Download a file</h1>
        <p className="text-sm text-zinc-500 text-center mb-8">
          Enter the file hash and token you received at upload time.
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="md5" className="block text-sm font-medium text-zinc-700 mb-1">
              File hash (MD5) <span className="text-red-500">*</span>
            </label>
            <input
              id="md5"
              type="text"
              required
              value={md5}
              onChange={(e) => setMd5(e.target.value)}
              placeholder="81967f4d5b2cf61bf0c8b65aed006387"
              autoFocus
              className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2.5 text-sm font-mono text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900"
            />
          </div>

          <div>
            <label htmlFor="token" className="block text-sm font-medium text-zinc-700 mb-1">
              Token <span className="text-red-500">*</span>
            </label>
            <input
              id="token"
              type="text"
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste your download token"
              className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2.5 text-sm font-mono text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900"
            />
          </div>

          <button
            type="submit"
            disabled={!md5.trim() || !token.trim()}
            className="w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2"
          >
            Download
          </button>
        </form>
      </div>
    </div>
  );
}
