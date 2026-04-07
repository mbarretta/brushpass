'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { FileRecord } from '@/types';

interface AdminGroupActionsProps {
  slug: string;
  name: string;
  allFiles: FileRecord[];
  memberIds: Set<number>;
}

// TODO: move to server-side search+pagination when file count grows beyond a few hundred
const PAGE_SIZE = 20;

export default function AdminGroupActions({ slug, name, allFiles, memberIds }: AdminGroupActionsProps) {
  const router = useRouter();
  const [newName, setNewName] = useState(name);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [memberLoading, setMemberLoading] = useState<number | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filePage, setFilePage] = useState(1);
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

  async function handleRename(e: React.FormEvent) {
    e.preventDefault();
    setRenaming(true);
    setRenameError(null);
    try {
      const res = await fetch(`/api/admin/groups/${slug}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setRenameError(data.error ?? 'Failed to rename');
        return;
      }
      router.refresh();
    } catch (err) {
      setRenameError(String(err));
    } finally {
      setRenaming(false);
    }
  }

  async function toggleMember(fileId: number, isMember: boolean) {
    setMemberLoading(fileId);
    setMemberError(null);
    try {
      const res = await fetch(`/api/admin/groups/${slug}/files`, {
        method: isMember ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMemberError(data.error ?? 'Failed to update membership');
        return;
      }
      router.refresh();
    } catch (err) {
      setMemberError(String(err));
    } finally {
      setMemberLoading(null);
    }
  }

  async function handleRegenerate() {
    setRegenerating(true);
    setRegenError(null);
    setRegenToken(null);
    try {
      const res = await fetch(`/api/admin/groups/${slug}`, { method: 'POST' });
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
    if (!confirm(`Delete group "${name}"? This cannot be undone. Files are not deleted.`)) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/admin/groups/${slug}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setDeleteError(data.error ?? 'Failed to delete group');
        setDeleting(false);
        return;
      }
      router.push('/admin/groups');
    } catch (err) {
      setDeleteError(String(err));
      setDeleting(false);
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <div className="space-y-6">
      {/* Rename */}
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-6">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 mb-4">Rename Group</h2>
        <form onSubmit={handleRename} className="flex items-center gap-3 flex-wrap">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            required
            className="flex-1 min-w-0 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-200"
          />
          <button
            type="submit"
            disabled={renaming}
            className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm font-medium px-4 py-2 hover:bg-zinc-700 dark:hover:bg-zinc-300 disabled:opacity-50 transition-colors"
          >
            {renaming ? 'Saving…' : 'Save'}
          </button>
        </form>
        {renameError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{renameError}</p>}
      </div>

      {/* File membership */}
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 overflow-hidden">
        <div className="px-6 py-4 border-b border-zinc-100 dark:border-zinc-800">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Files</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-0.5">Toggle files in or out of this group.</p>
        </div>
        {memberError && (
          <p className="px-6 py-3 text-sm text-red-600 dark:text-red-400">{memberError}</p>
        )}
        {allFiles.length === 0 ? (
          <p className="px-6 py-4 text-sm text-zinc-400">No files uploaded yet.</p>
        ) : (() => {
          const filtered = allFiles.filter((f) =>
            f.original_name.toLowerCase().includes(query.toLowerCase()),
          );
          const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
          const safePage = Math.min(filePage, totalPages);
          const pageFiles = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
          const start = (safePage - 1) * PAGE_SIZE + 1;
          const end = Math.min(safePage * PAGE_SIZE, filtered.length);

          return (
            <>
              <div className="px-6 py-3 border-b border-zinc-100 dark:border-zinc-800">
                <input
                  type="search"
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); setFilePage(1); }}
                  placeholder="Search files…"
                  className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-200"
                />
              </div>
              {pageFiles.length === 0 ? (
                <p className="px-6 py-4 text-sm text-zinc-400">No files match your search.</p>
              ) : (
                <ul>
                  {pageFiles.map((file, i) => {
                    const isMember = memberIds.has(file.id);
                    const isLoading = memberLoading === file.id;
                    return (
                      <li
                        key={file.id}
                        className={`flex items-center justify-between px-6 py-3 ${
                          i < pageFiles.length - 1 ? 'border-b border-zinc-50 dark:border-zinc-800/50' : ''
                        }`}
                      >
                        <div className="min-w-0 flex-1 mr-4">
                          <p className="text-sm text-zinc-900 dark:text-zinc-100 truncate">{file.original_name}</p>
                          <p className="text-xs text-zinc-400">{formatBytes(file.size)}</p>
                        </div>
                        <button
                          onClick={() => toggleMember(file.id, isMember)}
                          disabled={isLoading}
                          className={[
                            'flex-shrink-0 rounded-lg text-sm font-medium px-3 py-1.5 transition-colors disabled:opacity-50',
                            isMember
                              ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-red-50 dark:hover:bg-red-950 hover:text-red-700 dark:hover:text-red-400'
                              : 'bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900',
                          ].join(' ')}
                        >
                          {isLoading ? '…' : isMember ? 'Remove' : 'Add'}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {totalPages > 1 && (
                <div className="px-6 py-3 border-t border-zinc-100 dark:border-zinc-800 flex items-center justify-between">
                  <button
                    onClick={() => setFilePage((p) => Math.max(1, p - 1))}
                    disabled={safePage <= 1}
                    className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 disabled:opacity-30"
                  >
                    ← Prev
                  </button>
                  <span className="text-xs text-zinc-400">{start}–{end} of {filtered.length}</span>
                  <button
                    onClick={() => setFilePage((p) => Math.min(totalPages, p + 1))}
                    disabled={safePage >= totalPages}
                    className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 disabled:opacity-30"
                  >
                    Next →
                  </button>
                </div>
              )}
            </>
          );
        })()}
      </div>

      {/* Regenerate token */}
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-6">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 mb-3">Regenerate Token</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">
          Issues a new group access token and invalidates the old one. The new token is shown once.
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
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">New group token</p>
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

      {/* Delete */}
      <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-6">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 mb-2">Danger Zone</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
          Deletes the group and all membership records. Files themselves are not deleted.
        </p>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="rounded-lg bg-red-600 text-white text-sm font-medium px-4 py-2 hover:bg-red-700 disabled:opacity-50 transition-colors"
        >
          {deleting ? 'Deleting…' : 'Delete Group'}
        </button>
        {deleteError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{deleteError}</p>}
      </div>
    </div>
  );
}
