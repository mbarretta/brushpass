'use client';

import { useState } from 'react';
import type { FileGroupWithFiles } from '@/types';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface GroupPageProps {
  group: FileGroupWithFiles;
  slug: string;
}

export default function GroupPage({ group, slug }: GroupPageProps) {
  const [token, setToken] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const t = token.trim();
    if (!t) return;
    setError(null);
    setSubmitted(true);
  }

  function formatUnix(unix: number | null): string {
    if (unix === null) return 'No expiry';
    return new Date(unix * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' });
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">
        {!submitted ? (
          <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-8">
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mb-2 text-center">
              {group.name}
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center mb-6">
              {group.files.length} file{group.files.length !== 1 ? 's' : ''} · expires {formatUnix(group.expires_at)}
            </p>
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label
                  htmlFor="token"
                  className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1"
                >
                  Token <span className="text-red-500">*</span>
                </label>
                <input
                  id="token"
                  type="text"
                  required
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Paste your group token"
                  autoFocus
                  className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-4 py-2.5 text-sm font-mono text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-200"
                />
              </div>
              {error && (
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              )}
              <button
                type="submit"
                className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              >
                Access Files
              </button>
            </form>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-6">
              <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
                {group.name}
              </h1>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                {group.files.length} file{group.files.length !== 1 ? 's' : ''} · expires {formatUnix(group.expires_at)}
              </p>
            </div>

            {group.files.length === 0 ? (
              <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-8 text-center text-zinc-400 text-sm">
                No files in this group.
              </div>
            ) : (
              <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 overflow-hidden">
                {group.files.map((file, i) => (
                  <div
                    key={file.sha256}
                    className={`flex items-center justify-between px-5 py-4 ${
                      i < group.files.length - 1 ? 'border-b border-zinc-100 dark:border-zinc-800' : ''
                    }`}
                  >
                    <div className="min-w-0 flex-1 mr-4">
                      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                        {file.original_name}
                      </p>
                      <p className="text-xs text-zinc-400 mt-0.5">
                        {formatBytes(file.size)} · {file.content_type}
                      </p>
                    </div>
                    <a
                      href={`/api/groups/${slug}/files/${file.sha256}?token=${encodeURIComponent(token)}`}
                      className="flex-shrink-0 rounded-lg bg-blue-600 text-white text-sm font-medium px-4 py-1.5 hover:bg-blue-700 transition-colors"
                      download={file.original_name}
                    >
                      Download
                    </a>
                  </div>
                ))}
              </div>
            )}

            <button
              onClick={() => { setSubmitted(false); setToken(''); }}
              className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors w-full text-center"
            >
              ← Enter a different token
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
