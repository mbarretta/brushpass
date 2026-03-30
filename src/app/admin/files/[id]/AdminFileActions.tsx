'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';

interface AdminFileActionsProps {
  fileId: number;
  expiresAt: number | null;
}

function unixToDatetimeLocal(unix: number | null): string {
  if (unix === null) return '';
  const d = new Date(unix * 1000);
  // datetime-local needs "YYYY-MM-DDTHH:mm"
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export default function AdminFileActions({ fileId, expiresAt }: AdminFileActionsProps) {
  const router = useRouter();
  const [expiryValue, setExpiryValue] = useState<string>(unixToDatetimeLocal(expiresAt));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [regenToken, setRegenToken] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [copiedRegen, setCopiedRegen] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  async function handleSaveExpiry() {
    setSaving(true);
    setSaveError(null);
    try {
      const expires_at = expiryValue === '' ? null : Math.floor(new Date(expiryValue).getTime() / 1000);
      const res = await fetch(`/api/admin/files/${fileId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expires_at }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setSaveError(data.error ?? 'Failed to save expiry');
      } else {
        router.refresh();
      }
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleRegenerate() {
    setRegenerating(true);
    setRegenError(null);
    setRegenToken(null);
    try {
      const res = await fetch(`/api/admin/files/${fileId}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setRegenError(data.error ?? 'Failed to regenerate token');
        return;
      }
      setRegenToken(data.token);
    } catch (err) {
      setRegenError(String(err));
    } finally {
      setRegenerating(false);
    }
  }

  function copyRegenToken() {
    if (!regenToken) return;
    navigator.clipboard.writeText(regenToken);
    setCopiedRegen(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopiedRegen(false), 2000);
  }

  async function handleDelete() {
    if (!confirm('Delete this file? This cannot be undone.')) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/admin/files/${fileId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setDeleteError(data.error ?? 'Failed to delete file');
        setDeleting(false);
      } else {
        router.push('/admin');
      }
    } catch (err) {
      setDeleteError(String(err));
      setDeleting(false);
    }
  }

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-6 space-y-6">
      <div>
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 mb-3">
          Update Expiry
        </h2>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="datetime-local"
            value={expiryValue}
            onChange={(e) => setExpiryValue(e.target.value)}
            className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-200"
          />
          <button
            onClick={handleSaveExpiry}
            disabled={saving}
            className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm font-medium px-4 py-2 hover:bg-zinc-700 dark:hover:bg-zinc-300 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={() => setExpiryValue('')}
            className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
          >
            Clear (no expiry)
          </button>
        </div>
        {saveError && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{saveError}</p>
        )}
      </div>

      <div className="border-t border-zinc-100 dark:border-zinc-800 pt-6">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 mb-3">
          Regenerate Token
        </h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">
          Issues a new download token and invalidates the old one. The new token is shown once.
        </p>
        <button
          onClick={handleRegenerate}
          disabled={regenerating}
          className="rounded-lg bg-amber-500 text-white text-sm font-medium px-4 py-2 hover:bg-amber-600 disabled:opacity-50 transition-colors"
        >
          {regenerating ? 'Regenerating…' : 'Regenerate Token'}
        </button>
        {regenError && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{regenError}</p>
        )}
        {regenToken && (
          <div className="mt-4 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 p-4 space-y-3">
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">New download token</p>
            <p className="font-mono text-sm text-zinc-800 dark:text-zinc-200 break-all">{regenToken}</p>
            <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              ⚠ Save this token — it will not be shown again.
            </div>
            <button
              onClick={copyRegenToken}
              className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm font-medium px-4 py-2 hover:bg-zinc-700 dark:hover:bg-zinc-300 transition-colors"
            >
              {copiedRegen ? 'Copied!' : 'Copy token'}
            </button>
          </div>
        )}
      </div>

      <div className="border-t border-zinc-100 dark:border-zinc-800 pt-6">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 mb-3">
          Danger Zone
        </h2>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="rounded-lg bg-red-600 text-white text-sm font-medium px-4 py-2 hover:bg-red-700 disabled:opacity-50 transition-colors"
        >
          {deleting ? 'Deleting…' : 'Delete File'}
        </button>
        {deleteError && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{deleteError}</p>
        )}
      </div>
    </div>
  );
}
