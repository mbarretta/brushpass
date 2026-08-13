'use client';

import { useState } from 'react';

/**
 * Token entry for a single file's download page.
 *
 * This is a client component purely so the token can travel in a POST body.
 * The form it replaced was `<form method="get" action="/api/download/...">`,
 * which put the capability token in the query string of every download — where
 * it was recorded verbatim in Cloud Logging, the browser's history, and any
 * Referer sent onward. Here the token is POSTed, the route answers with a
 * short-lived signed GCS URL, and the browser navigates to that instead.
 *
 * Tradeoff, accepted: this path now needs JavaScript, where the GET form did
 * not. The rest of the app is already client-rendered, and the `?token=` GET
 * route still exists for links that were shared before this change.
 */
export default function TokenForm({ sha256 }: { sha256: string }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const value = token.trim();
    if (!value || busy) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/download/${sha256}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: value }),
      });

      if (res.ok) {
        const { url } = (await res.json()) as { url: string };
        window.location.href = url;
        return;
      }

      // 401 covers an unknown file, an expired-and-untokened file and a wrong
      // token alike — the route answers all three identically on purpose, so
      // this message must not speculate about which one it was.
      if (res.status === 401) setError('That token is not valid for this file.');
      else if (res.status === 410) setError('This file has expired and is no longer available.');
      else if (res.status === 429) setError('Too many attempts. Wait a minute and try again.');
      else setError('Download failed. Please try again.');
    } catch {
      setError('Download failed. Please check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <input
        name="token"
        type="text"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="Paste token here"
        required
        autoFocus
        className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-4 py-2.5 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-200"
      />
      <button
        type="submit"
        disabled={!token.trim() || busy}
        className="w-full rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm font-medium py-2.5 hover:bg-zinc-700 dark:hover:bg-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {busy ? 'Preparing download…' : 'Download'}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}
