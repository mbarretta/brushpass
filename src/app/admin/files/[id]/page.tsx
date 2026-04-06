import Link from 'next/link';
import { getFileById, getDownloadLogs } from '@/lib/db';
import { getIsAdmin } from '@/lib/admin-auth';
import AdminFileActions from './AdminFileActions';

export const metadata = { title: 'Admin — File Detail' };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUnix(unix: number | null): string {
  if (unix === null) return '—';
  return new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export default async function AdminFileDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!(await getIsAdmin())) {
    return (
      <div className="min-h-screen flex items-center justify-center text-zinc-500 text-sm">
        403 Forbidden
      </div>
    );
  }

  const { id } = await params;
  const numericId = parseInt(id, 10);

  if (isNaN(numericId)) {
    return (
      <div className="min-h-screen flex items-center justify-center text-zinc-500 text-sm">
        Invalid file ID.
      </div>
    );
  }

  const file = getFileById(numericId);

  if (!file) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 flex items-center justify-center px-4">
        <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-8 text-center">
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
            File Not Found
          </h1>
          <p className="text-zinc-500 dark:text-zinc-400 text-sm mb-4">
            No file with ID {numericId} exists.
          </p>
          <Link href="/admin" className="text-sm text-zinc-500 hover:underline">
            ← Back to file list
          </Link>
        </div>
      </div>
    );
  }

  const download_logs = getDownloadLogs(numericId);

  // Destructure token_hash out — never render it
  const { token_hash: _th, ...safeFile } = file;

  const fields: [string, string][] = [
    ['ID', String(safeFile.id)],
    ['Original name', safeFile.original_name],
    ['SHA-256', safeFile.sha256],
    ['Size', formatBytes(safeFile.size)],
    ['Content type', safeFile.content_type],
    ['GCS key', safeFile.gcs_key],
    ['Expires at', formatUnix(safeFile.expires_at)],
    ['Uploaded at', formatUnix(safeFile.uploaded_at)],
    ['Uploaded by', safeFile.uploaded_by ?? '—'],
  ];

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 px-4 py-10 pr-40">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <Link href="/admin" className="text-sm text-zinc-500 hover:underline">
            ← Files
          </Link>
          <span className="text-zinc-300 dark:text-zinc-700">/</span>
          <span className="text-sm text-zinc-900 dark:text-zinc-100 font-medium">
            {safeFile.original_name}
          </span>
        </div>

        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
          File Detail
        </h1>

        {/* Metadata card */}
        <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800">
          {fields.map(([label, value]) => (
            <div key={label} className="px-5 py-3 text-sm">
              <p className="text-zinc-500 dark:text-zinc-400 text-xs mb-0.5">{label}</p>
              <p className="text-zinc-900 dark:text-zinc-100 font-mono break-all">{value}</p>
            </div>
          ))}
          <div className="px-5 py-3 text-sm">
            <p className="text-zinc-500 dark:text-zinc-400 text-xs mb-0.5">Downloads</p>
            <p className="text-zinc-900 dark:text-zinc-100 font-semibold">{download_logs.length}</p>
          </div>
        </div>

        {/* Download log table */}
        <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          <div className="px-5 py-3 border-b border-zinc-100 dark:border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Download Log
            </h2>
          </div>
          {download_logs.length === 0 ? (
            <p className="px-5 py-4 text-sm text-zinc-400">No downloads recorded.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <th className="text-left px-5 py-2 text-zinc-500 dark:text-zinc-400 font-medium">#</th>
                  <th className="text-left px-5 py-2 text-zinc-500 dark:text-zinc-400 font-medium">Downloaded at</th>
                </tr>
              </thead>
              <tbody>
                {download_logs.map((log, i) => (
                  <tr key={log.id} className="border-b border-zinc-50 dark:border-zinc-800/50 last:border-0">
                    <td className="px-5 py-2 text-zinc-400">{download_logs.length - i}</td>
                    <td className="px-5 py-2 text-zinc-600 dark:text-zinc-300 font-mono">
                      {formatUnix(log.downloaded_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Mutations (client component) */}
        <AdminFileActions fileId={safeFile.id} expiresAt={safeFile.expires_at} />
      </div>
    </div>
  );
}
