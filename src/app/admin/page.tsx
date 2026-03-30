import { redirect } from 'next/navigation';
import Link from 'next/link';
import { listFiles } from '@/lib/db';
import { getIsAdmin } from '@/lib/admin-auth';

export const metadata = { title: 'Admin — Files' };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatExpiry(expiresAt: number | null): string {
  if (expiresAt === null) return 'Never';
  return new Date(expiresAt * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export default async function AdminFilesPage() {
  if (!(await getIsAdmin())) {
    redirect('/login');
  }

  const files = listFiles();

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 px-4 py-10">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
            Admin — Files
          </h1>
          <Link
            href="/admin/users"
            className="rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm text-zinc-700 dark:text-zinc-300 font-medium px-4 py-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            Users →
          </Link>
        </div>

        {files.length === 0 ? (
          <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-8 text-center text-zinc-400 text-sm">
            No files uploaded yet.
          </div>
        ) : (
          <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800">
                  <th className="text-left px-5 py-3 text-zinc-500 dark:text-zinc-400 font-medium">Name</th>
                  <th className="text-left px-5 py-3 text-zinc-500 dark:text-zinc-400 font-medium">MD5</th>
                  <th className="text-right px-5 py-3 text-zinc-500 dark:text-zinc-400 font-medium">Size</th>
                  <th className="text-left px-5 py-3 text-zinc-500 dark:text-zinc-400 font-medium">Expiry</th>
                  <th className="text-right px-5 py-3 text-zinc-500 dark:text-zinc-400 font-medium">Downloads</th>
                  <th className="text-left px-5 py-3 text-zinc-500 dark:text-zinc-400 font-medium">Uploaded</th>
                  <th className="text-left px-5 py-3 text-zinc-500 dark:text-zinc-400 font-medium">Uploaded By</th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr
                    key={file.id}
                    className="border-b border-zinc-100 dark:border-zinc-800 last:border-0 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                  >
                    <td className="px-5 py-3">
                      <Link
                        href={`/admin/files/${file.id}`}
                        className="text-zinc-900 dark:text-zinc-100 hover:underline font-medium"
                      >
                        {file.original_name}
                      </Link>
                    </td>
                    <td className="px-5 py-3 font-mono text-zinc-500 dark:text-zinc-400">
                      {file.md5.slice(0, 12)}…
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
                    <td className="px-5 py-3 text-zinc-500 dark:text-zinc-400">{file.uploaded_by ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
