import Link from 'next/link';
import { auth } from '@/auth';

// SVG icon primitives — inline for zero-dependency nav
function UploadIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="17 8 12 3 7 8"/>
      <line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  );
}

function AdminIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7"/>
      <rect x="14" y="3" width="7" height="7"/>
      <rect x="14" y="14" width="7" height="7"/>
      <rect x="3" y="14" width="7" height="7"/>
    </svg>
  );
}

function UserIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4"/>
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
    </svg>
  );
}

export default async function NavBar() {
  const session = await auth();
  const isAuthed = !!session;
  const isAdmin = session?.user?.permissions?.includes('admin') ?? false;

  const btnClass =
    'inline-flex items-center justify-center w-9 h-9 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400';

  return (
    <nav
      aria-label="Site navigation"
      className="fixed top-3 right-4 z-50 flex items-center gap-1 bg-white/80 backdrop-blur-sm border border-zinc-200 rounded-xl px-2 py-1.5 shadow-sm"
    >
      {isAuthed && (
        <Link href="/upload" className={btnClass} title="Upload">
          <UploadIcon />
          <span className="sr-only">Upload</span>
        </Link>
      )}

      <Link href="/download" className={btnClass} title="Download">
        <DownloadIcon />
        <span className="sr-only">Download</span>
      </Link>

      {isAdmin && (
        <Link href="/admin" className={btnClass} title="Admin">
          <AdminIcon />
          <span className="sr-only">Admin</span>
        </Link>
      )}

      {isAuthed && (
        <Link href="/account" className={btnClass} title="Account">
          <UserIcon />
          <span className="sr-only">Account</span>
        </Link>
      )}
    </nav>
  );
}
