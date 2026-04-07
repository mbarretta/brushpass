'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import type { FileRecord } from '@/types';

type FileRow = FileRecord & { download_count: number };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatExpiry(expiresAt: number | null): string {
  if (expiresAt === null) return 'Never';
  return new Date(expiresAt * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

interface Props {
  files: FileRow[];
}

export default function AdminFilesClient({ files }: Props) {
  const [rows, setRows] = useState<FileRow[]>(files);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [failedNames, setFailedNames] = useState<string[]>([]);
  const [isDeleting, setIsDeleting] = useState(false);

  const allSelected = rows.length > 0 && selected.size === rows.length;
  const someSelected = selected.size > 0 && !allSelected;

  const toggleAll = useCallback(() => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(rows.map((r) => r.id)));
    }
  }, [allSelected, rows]);

  const toggleRow = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleDelete = useCallback(async () => {
    const count = selected.size;
    if (count === 0) return;
    if (!window.confirm(`Delete ${count} file${count === 1 ? '' : 's'}?`)) return;

    setIsDeleting(true);
    setFailedNames([]);

    try {
      const res = await fetch('/api/admin/files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selected] }),
      });

      const data = (await res.json()) as {
        results: { id: number; ok: boolean; error?: string }[];
      };

      const results = data.results ?? [];
      const succeededIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
      const failedResults = results.filter((r) => !r.ok);

      // Optimistically remove succeeded rows
      setRows((prev) => prev.filter((row) => !succeededIds.has(row.id)));

      // Clear selection (deselect everything that succeeded; keep failed rows selected)
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of succeededIds) next.delete(id);
        return next;
      });

      // Collect names for failed rows to show in error banner
      if (failedResults.length > 0) {
        const failedIdsSet = new Set(failedResults.map((r) => r.id));
        const names = rows
          .filter((row) => failedIdsSet.has(row.id))
          .map((row) => row.original_name);
        setFailedNames(names);
      }
    } catch (err) {
      console.error('[admin] bulk-delete fetch error', err);
      setFailedNames(['Network error — please try again.']);
    } finally {
      setIsDeleting(false);
    }
  }, [selected, rows]);

  return (
    <>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
          Admin — Files
        </h1>
        <div className="flex items-center gap-3">
          {selected.size > 0 && (
            <button
              onClick={handleDelete}
              disabled={isDeleting}
              className="rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 transition-colors"
            >
              {isDeleting
                ? 'Deleting…'
                : `Delete ${selected.size} file${selected.size === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>

      {/* Error banner */}
      {failedNames.length > 0 && (
        <div className="mb-4 rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          <strong>Failed to delete:</strong>{' '}
          {failedNames.join(', ')}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-8 text-center text-zinc-400 text-sm">
          No files uploaded yet.
        </div>
      ) : (
        <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800">
                <th className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected;
                    }}
                    onChange={toggleAll}
                    aria-label="Select all files"
                    className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-600 cursor-pointer"
                  />
                </th>
                <th className="text-left px-5 py-3 text-zinc-500 dark:text-zinc-400 font-medium">Name</th>
                <th className="text-left px-5 py-3 text-zinc-500 dark:text-zinc-400 font-medium">SHA-256</th>
                <th className="text-right px-5 py-3 text-zinc-500 dark:text-zinc-400 font-medium">Size</th>
                <th className="text-left px-5 py-3 text-zinc-500 dark:text-zinc-400 font-medium">Expiry</th>
                <th className="text-right px-5 py-3 text-zinc-500 dark:text-zinc-400 font-medium">Downloads</th>
                <th className="text-left px-5 py-3 text-zinc-500 dark:text-zinc-400 font-medium">Uploaded</th>
                <th className="text-left px-5 py-3 text-zinc-500 dark:text-zinc-400 font-medium">Uploaded By</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((file) => (
                <tr
                  key={file.id}
                  className="border-b border-zinc-100 dark:border-zinc-800 last:border-0 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                >
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(file.id)}
                      onChange={() => toggleRow(file.id)}
                      aria-label={`Select ${file.original_name}`}
                      className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-600 cursor-pointer"
                    />
                  </td>
                  <td className="px-5 py-3">
                    <Link
                      href={`/admin/files/${file.id}`}
                      className="text-zinc-900 dark:text-zinc-100 hover:underline font-medium"
                    >
                      {file.original_name}
                    </Link>
                  </td>
                  <td className="px-5 py-3 font-mono text-zinc-500 dark:text-zinc-400">
                    {file.sha256.slice(0, 12)}…
                  </td>
                  <td className="px-5 py-3 text-right text-zinc-600 dark:text-zinc-300">
                    {formatBytes(file.size)}
                  </td>
                  <td className="px-5 py-3 text-zinc-600 dark:text-zinc-300">
                    {formatExpiry(file.expires_at)}
                  </td>
                  <td className="px-5 py-3 text-right text-zinc-600 dark:text-zinc-300">
                    {file.download_count}
                  </td>
                  <td className="px-5 py-3 text-zinc-500 dark:text-zinc-400">
                    {new Date(file.uploaded_at * 1000).toISOString().replace('T', ' ').slice(0, 10)}
                  </td>
                  <td className="px-5 py-3 text-zinc-500 dark:text-zinc-400">
                    {file.uploaded_by ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
