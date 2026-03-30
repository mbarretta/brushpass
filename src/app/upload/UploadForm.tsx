'use client';

import { useState, useRef } from 'react';

interface UploadResult {
  url: string;
  token: string;
  expires_at: number | null;
}

export default function UploadForm() {
  const [file, setFile] = useState<File | null>(null);
  const [expireCount, setExpireCount] = useState<string>('');
  const [expireUnit, setExpireUnit] = useState<'h' | 'd'>('d');
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!file) return;

    setLoading(true);
    setError(null);
    setResult(null);
    setCopied(false);

    try {
      const formData = new FormData();
      formData.append('file', file);
      if (expireCount) {
        formData.append('expires_in', `${expireCount}${expireUnit}`);
      }

      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      const json = await res.json();

      if (!res.ok) {
        setError((json as { error?: string }).error ?? `Upload failed (${res.status})`);
      } else {
        setResult(json as UploadResult);
        // Reset form
        setFile(null);
        setExpireCount('');
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  async function copyToken() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable
    }
  }

  const downloadUrl = result ? `${window.location.origin}${result.url}` : '';

  return (
    <div className="min-h-screen bg-zinc-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-zinc-200 p-8">
        <h1 className="text-2xl font-semibold text-zinc-900 mb-6 text-center">Upload a file</h1>

        {error && (
          <div
            role="alert"
            className="mb-5 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            {error}
          </div>
        )}

        {result ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 space-y-3">
              <div>
                <p className="text-xs font-medium text-zinc-500 mb-1">Download URL</p>
                <a
                  href={downloadUrl}
                  className="block text-sm text-blue-600 hover:underline break-all"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {downloadUrl}
                </a>
              </div>

              <div>
                <p className="text-xs font-medium text-zinc-500 mb-1">Token</p>
                <p className="font-mono text-sm text-zinc-800 break-all">{result.token}</p>
              </div>

              {result.expires_at !== null && (
                <div>
                  <p className="text-xs font-medium text-zinc-500 mb-1">Expires</p>
                  <p className="text-sm text-zinc-700">
                    {new Date(result.expires_at * 1000).toLocaleString()}
                  </p>
                </div>
              )}
            </div>

            <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              ⚠ Save this token — it will not be shown again.
            </div>

            <button
              type="button"
              onClick={copyToken}
              className="w-full rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2"
            >
              {copied ? 'Copied!' : 'Copy token'}
            </button>

            <button
              type="button"
              onClick={() => setResult(null)}
              className="w-full rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 transition-colors"
            >
              Upload another file
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label
                htmlFor="file"
                className="block text-sm font-medium text-zinc-700 mb-1"
              >
                File <span className="text-red-500">*</span>
              </label>
              <input
                id="file"
                ref={fileInputRef}
                type="file"
                required
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="w-full text-sm text-zinc-700 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-zinc-700 hover:file:bg-zinc-200"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">
                Expires in <span className="text-zinc-400 text-xs">(optional)</span>
              </label>
              <div className="flex gap-2">
                <input
                  type="number"
                  min="1"
                  max="365"
                  value={expireCount}
                  onChange={(e) => setExpireCount(e.target.value)}
                  placeholder="No expiry"
                  className="flex-1 rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <select
                  value={expireUnit}
                  onChange={(e) => setExpireUnit(e.target.value as 'h' | 'd')}
                  className="rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="h">hours</option>
                  <option value="d">days</option>
                </select>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || !file}
              className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            >
              {loading ? 'Uploading…' : 'Upload'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
