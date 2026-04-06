'use client';

import { useState, useRef } from 'react';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

interface UploadResult {
  url: string;
  token: string;
  expires_at: number | null;
}

interface PrepareCollisionResponse {
  type: 'collision';
  url: string;
  token: string;
  expires_at: number | null;
}

interface PrepareUploadResponse {
  type: 'upload';
  signedUrl: string;
  gcsKey: string;
  contentType: string;
}

type PrepareResponse = PrepareCollisionResponse | PrepareUploadResponse;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function UploadForm() {
  const [file, setFile] = useState<File | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [expireCount, setExpireCount] = useState<string>('');
  const [expireUnit, setExpireUnit] = useState<'h' | 'd'>('d');
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  type UploadPhase = 'hashing' | 'uploading' | null;
  const [phase, setPhase] = useState<UploadPhase>(null);
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function resetForm() {
    setFile(null);
    setFileSize(null);
    setExpireCount('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!file) return;

    setLoading(true);
    setError(null);
    setResult(null);
    setCopied(false);
    setProgress(null);
    setPhase(null);

    try {
      // Step A — Hash the file client-side in 64MB chunks
      const CHUNK_SIZE = 64 * 1024 * 1024; // 64MB
      const hasher = nobleSha256.create();
      let offset = 0;
      setPhase('hashing');
      setProgress(0);
      while (offset < file.size) {
        const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
        hasher.update(new Uint8Array(chunk));
        offset += CHUNK_SIZE;
        setProgress(Math.min(100, Math.round((offset / file.size) * 100)));
      }
      const sha256Hex = bytesToHex(hasher.digest());

      // Step B — Call prepare
      const prepareBody: Record<string, unknown> = {
        sha256: sha256Hex,
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
      };
      if (expireCount) prepareBody.expires_in = `${expireCount}${expireUnit}`;

      const prepareRes = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prepareBody),
      });
      const prepareJson = await prepareRes.json() as PrepareResponse;
      if (!prepareRes.ok) {
        setError((prepareJson as { error?: string }).error ?? `Prepare failed (${prepareRes.status})`);
        return;
      }

      // Step C — Handle collision shortcut (file already uploaded)
      if (prepareJson.type === 'collision') {
        setResult({ url: prepareJson.url, token: prepareJson.token, expires_at: prepareJson.expires_at });
        resetForm();
        return;
      }

      // Step D — PUT directly to GCS signed URL
      const { signedUrl, gcsKey, contentType: signedContentType } = prepareJson;
      setPhase('uploading');
      setProgress(0);
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`GCS PUT failed: ${xhr.status}`));
        };
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.open('PUT', signedUrl);
        xhr.setRequestHeader('Content-Type', signedContentType); // must match signed URL contentType exactly
        xhr.send(file);
      });

      // Step E — Call complete to record DB metadata
      const completeBody: Record<string, unknown> = {
        sha256: sha256Hex,
        gcsKey,
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
      };
      if (expireCount) completeBody.expires_in = `${expireCount}${expireUnit}`;

      const completeRes = await fetch('/api/upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(completeBody),
      });
      const completeJson = await completeRes.json() as UploadResult;
      if (!completeRes.ok) {
        setError((completeJson as { error?: string }).error ?? `Complete failed (${completeRes.status})`);
        return;
      }
      setResult(completeJson);
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setLoading(false);
      setProgress(null);
      setPhase(null);
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
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-8">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mb-6 text-center">Upload a file</h1>

        {error && (
          <div
            role="alert"
            className="mb-5 rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950 px-4 py-3 text-sm text-red-700 dark:text-red-400"
          >
            {error}
          </div>
        )}

        {result ? (
          <div className="space-y-4">
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 p-4 space-y-3">
              <div>
                <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Download URL</p>
                <a
                  href={downloadUrl}
                  className="block text-sm text-blue-600 dark:text-blue-400 hover:underline break-all"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {downloadUrl}
                </a>
              </div>

              <div>
                <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Token</p>
                <p className="font-mono text-sm text-zinc-800 dark:text-zinc-200 break-all">{result.token}</p>
              </div>

              {result.expires_at !== null && (
                <div>
                  <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Expires</p>
                  <p className="text-sm text-zinc-700 dark:text-zinc-300">
                    {new Date(result.expires_at * 1000).toLocaleString()}
                  </p>
                </div>
              )}
            </div>

            <div className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
              ⚠ Save this token — it will not be shown again.
            </div>

            <button
              type="button"
              onClick={copyToken}
              className="w-full rounded-lg bg-zinc-900 dark:bg-zinc-100 px-4 py-2 text-sm font-medium text-white dark:text-zinc-900 hover:bg-zinc-700 dark:hover:bg-zinc-300 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2"
            >
              {copied ? 'Copied!' : 'Copy token'}
            </button>

            <button
              type="button"
              onClick={() => setResult(null)}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
            >
              Upload another file
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label
                htmlFor="file"
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1"
              >
                File <span className="text-red-500">*</span>
              </label>
              <input
                id="file"
                ref={fileInputRef}
                type="file"
                required
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setFile(f);
                  setFileSize(f?.size ?? null);
                }}
                className="w-full text-sm text-zinc-700 dark:text-zinc-300 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-100 dark:file:bg-zinc-800 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-zinc-700 dark:file:text-zinc-300 hover:file:bg-zinc-200 dark:hover:file:bg-zinc-700"
              />
              {fileSize !== null && (
                <p className="text-xs text-zinc-500 mt-1">{formatBytes(fileSize)}</p>
              )}
            </div>

            {phase !== null && progress !== null && (
              <div>
                <p className="text-xs text-zinc-500 mb-1">
                  {phase === 'hashing' ? `Computing checksum\u2026 ${progress}%` : `Uploading\u2026 ${progress}%`}
                </p>
                <div className="w-full bg-zinc-100 dark:bg-zinc-800 rounded-full h-2 overflow-hidden">
                  <div
                    className={`h-2 rounded-full transition-all duration-150 ${
                      phase === 'hashing' ? 'bg-amber-500' : 'bg-blue-600'
                    }`}
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                Expires in <span className="text-zinc-400 dark:text-zinc-500 text-xs">(optional)</span>
              </label>
              <div className="flex gap-2">
                <input
                  type="number"
                  min="1"
                  max="365"
                  value={expireCount}
                  onChange={(e) => setExpireCount(e.target.value)}
                  placeholder="No expiry"
                  className="flex-1 rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-zinc-400 dark:placeholder-zinc-500"
                />
                <select
                  value={expireUnit}
                  onChange={(e) => setExpireUnit(e.target.value as 'h' | 'd')}
                  className="rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
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
              {loading
                ? phase === 'hashing'
                  ? 'Computing checksum\u2026'
                  : 'Uploading\u2026'
                : 'Upload'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
