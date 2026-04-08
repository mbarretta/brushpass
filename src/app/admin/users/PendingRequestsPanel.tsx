'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PermissionRequest } from '@/types';

export default function PendingRequestsPanel({ requests }: { requests: PermissionRequest[] }) {
  const router = useRouter();
  // Per-row state: loading | success message | error message
  const [rowState, setRowState] = useState<Record<number, { loading: boolean; message?: string; error?: string }>>({});

  if (requests.length === 0) return null;

  async function handleApprove(id: number) {
    setRowState((s) => ({ ...s, [id]: { loading: true } }));
    try {
      const res = await fetch(`/api/admin/permission-requests/${id}/approve`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRowState((s) => ({ ...s, [id]: { loading: false, error: body.error ?? `Error ${res.status}` } }));
        return;
      }
      setRowState((s) => ({
        ...s,
        [id]: { loading: false, message: 'Approved. User must sign out and back in to activate permissions.' },
      }));
      router.refresh();
    } catch (err) {
      setRowState((s) => ({ ...s, [id]: { loading: false, error: String(err) } }));
    }
  }

  async function handleDeny(id: number) {
    setRowState((s) => ({ ...s, [id]: { loading: true } }));
    try {
      const res = await fetch(`/api/admin/permission-requests/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setRowState((s) => ({ ...s, [id]: { loading: false, error: body.error ?? `Error ${res.status}` } }));
        return;
      }
      setRowState((s) => ({ ...s, [id]: { loading: false } }));
      router.refresh();
    } catch (err) {
      setRowState((s) => ({ ...s, [id]: { loading: false, error: String(err) } }));
    }
  }

  return (
    <section className="mb-6">
      <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-3">
        Pending Permission Requests
      </h2>
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800">
        {requests.map((req) => {
          const state = rowState[req.id] ?? { loading: false };
          const isLoading = state.loading;

          return (
            <div key={req.id} className="px-5 py-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {req.username}
                  {req.email ? (
                    <span className="ml-2 text-zinc-400 font-normal">{req.email}</span>
                  ) : (
                    <span className="ml-2 text-zinc-400 font-normal">—</span>
                  )}
                </p>
                <div className="flex flex-wrap gap-1 mt-1">
                  {req.requested_permissions.map((p) => (
                    <span
                      key={p}
                      className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"
                    >
                      {p}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-zinc-400 mt-1">
                  Requested {new Date(req.requested_at * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC
                </p>
                {state.message && (
                  <p className="text-xs text-green-600 dark:text-green-400 mt-1">{state.message}</p>
                )}
                {state.error && (
                  <p className="text-xs text-red-500 mt-1">{state.error}</p>
                )}
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  disabled={isLoading}
                  onClick={() => handleApprove(req.id)}
                  className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-xs font-medium px-3 py-1.5 hover:bg-zinc-700 dark:hover:bg-zinc-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Approve
                </button>
                <button
                  disabled={isLoading}
                  onClick={() => handleDeny(req.id)}
                  className="rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 text-xs font-medium px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Deny
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
