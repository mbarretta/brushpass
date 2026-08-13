'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

interface GroupUploadProps {
  slug: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type Phase = 'hashing' | 'uploading' | null;

export default function GroupUpload({ slug }: GroupUploadProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [expireCount, setExpireCount] = useState('');
  const [expireUnit, setExpireUnit] = useState<'h' | 'd'>('d');
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<Phase>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setFile(null);
    setExpireCount('');
    setError(null);
    setSuccess(null);
    setPhase(null);
    setProgress(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setLoading(true);
    setError(null);
    setSuccess(null);
    setProgress(null);
    setPhase(null);

    try {
      // Step A: Hash
      const CHUNK = 64 * 1024 * 1024;
      const hasher = nobleSha256.create();
      let offset = 0;
      setPhase('hashing');
      setProgress(0);
      while (offset < file.size) {
        const chunk = await file.slice(offset, offset + CHUNK).arrayBuffer();
        hasher.update(new Uint8Array(chunk));
        offset += CHUNK;
        setProgress(Math.min(100, Math.round((offset / file.size) * 100)));
      }
      const sha256Hex = bytesToHex(hasher.digest());

      // Step B: Prepare
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
      const prepareJson = await prepareRes.json() as Record<string, unknown>;
      if (!prepareRes.ok) {
        if (prepareRes.status === 403) {
          setError('Upload permission required. Ask an admin to grant you upload access.');
        } else {
          setError((prepareJson.error as string) ?? `Prepare failed (${prepareRes.status})`);
        }
        return;
      }

      let fileId: number;

      if (prepareJson.type === 'collision') {
        // File already exists — resolve its id via sha256 lookup
        const lookupRes = await fetch(`/api/admin/files?sha256=${sha256Hex}`);
        if (!lookupRes.ok) { setError('Could not resolve file ID for existing file.'); return; }
        const existing = await lookupRes.json() as { id: number };
        fileId = existing.id;
      } else {
        // Step C: PUT to GCS
        const { signedUrl, contentType: signedContentType } = prepareJson as {
          signedUrl: string; contentType: string;
        };
        setPhase('uploading');
        setProgress(0);
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.upload.onprogress = (ev) => {
            if (ev.lengthComputable) setProgress(Math.round((ev.loaded / ev.total) * 100));
          };
          xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`GCS PUT ${xhr.status}`));
          xhr.onerror = () => reject(new Error('Network error during upload'));
          xhr.onabort = () => resolve();
          xhr.open('PUT', signedUrl);
          xhr.setRequestHeader('Content-Type', signedContentType);
          xhr.send(file);
        });

        // Step D: Complete. The server re-derives the object key from
        // sha256 + filename itself (see deriveGcsKey) — it does not accept
        // one from the client.
        const completeBody: Record<string, unknown> = {
          sha256: sha256Hex,
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
        const completeJson = await completeRes.json() as { id?: number; error?: string };
        if (!completeRes.ok) { setError(completeJson.error ?? `Complete failed (${completeRes.status})`); return; }
        if (!completeJson.id) { setError('Upload complete but file ID not returned.'); return; }
        fileId = completeJson.id;
      }

      // Step E: Add to group
      const memberRes = await fetch(`/api/admin/groups/${slug}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId }),
      });
      if (!memberRes.ok) {
        const memberJson = await memberRes.json() as { error?: string };
        setError(memberJson.error ?? 'File uploaded but could not add to group.');
        return;
      }

      setSuccess(`"${file.name}" uploaded and added to group.`);
      reset();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setLoading(false);
      setProgress(null);
      setPhase(null);
    }
  }

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); setError(null); setSuccess(null); }}
        className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
      >
        <div>
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Upload File to Group</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-0.5">
            Upload a new file and add it to this group automatically.
          </p>
        </div>
        <span className="text-zinc-400 text-lg ml-4">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <div className="px-6 pb-6 border-t border-zinc-100 dark:border-zinc-800 pt-5">
          {error && (
            <div role="alert" className="mb-4 rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950 px-4 py-3 text-sm text-red-700 dark:text-red-400">
              {error}
            </div>
          )}
          {success && (
            <div className="mb-4 rounded border border-green-300 dark:border-green-800 bg-green-50 dark:bg-green-950 px-4 py-3 text-sm text-green-700 dark:text-green-400">
              ✓ {success}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="group-file" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                File <span className="text-red-500">*</span>
              </label>
              <input
                id="group-file"
                ref={fileInputRef}
                type="file"
                required
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="w-full text-sm text-zinc-700 dark:text-zinc-300 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-100 dark:file:bg-zinc-800 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-zinc-700 dark:file:text-zinc-300 hover:file:bg-zinc-200 dark:hover:file:bg-zinc-700"
              />
              {file && <p className="text-xs text-zinc-500 mt-1">{formatBytes(file.size)}</p>}
            </div>

            {phase !== null && progress !== null && (
              <div>
                <p className="text-xs text-zinc-500 mb-1">
                  {phase === 'hashing' ? `Computing checksum… ${progress}%` : `Uploading… ${progress}%`}
                </p>
                <div className="w-full bg-zinc-100 dark:bg-zinc-800 rounded-full h-2 overflow-hidden">
                  <div
                    className={`h-2 rounded-full transition-all duration-150 ${phase === 'hashing' ? 'bg-amber-500' : 'bg-blue-600'}`}
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                Expires in <span className="text-zinc-400 text-xs">(optional)</span>
              </label>
              <div className="flex gap-2">
                <input
                  type="number" min="1" max="365"
                  value={expireCount}
                  onChange={(e) => setExpireCount(e.target.value)}
                  placeholder="No expiry"
                  className="flex-1 rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-zinc-400"
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
              className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading
                ? phase === 'hashing' ? 'Computing checksum…' : 'Uploading…'
                : 'Upload & Add to Group'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
