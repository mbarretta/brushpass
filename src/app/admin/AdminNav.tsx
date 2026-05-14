'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const tabs = [
  { label: 'Files', href: '/admin' },
  { label: 'File Groups', href: '/admin/groups' },
  { label: 'Users', href: '/admin/users' },
] as const;

export default function AdminNav({ pendingCount = 0 }: { pendingCount?: number }) {
  const pathname = usePathname();

  // Determine active tab
  const activeHref = pathname.startsWith('/admin/users')
    ? '/admin/users'
    : pathname.startsWith('/admin/groups')
    ? '/admin/groups'
    : '/admin';

  return (
    <div className="-ml-20 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
      <nav
        aria-label="Admin sections"
        className="max-w-5xl mx-auto px-4 flex gap-1 pr-40"
      >
        {tabs.map(({ label, href }) => {
          const isActive = href === activeHref;
          return (
            <Link
              key={href}
              href={href}
              className={[
                'px-4 py-3 text-sm font-medium border-b-2 transition-colors inline-flex items-center gap-1',
                isActive
                  ? 'border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100'
                  : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 hover:border-zinc-300 dark:hover:border-zinc-600',
              ].join(' ')}
              aria-current={isActive ? 'page' : undefined}
            >
              {label}
              {label === 'Users' && pendingCount > 0 ? (
                <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold w-4 h-4">
                  {pendingCount}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
