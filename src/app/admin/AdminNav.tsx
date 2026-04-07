'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const tabs = [
  { label: 'Files', href: '/admin' },
  { label: 'Users', href: '/admin/users' },
] as const;

export default function AdminNav() {
  const pathname = usePathname();

  // Determine active tab: /admin/users/** → Users, everything else → Files
  const activeHref = pathname.startsWith('/admin/users') ? '/admin/users' : '/admin';

  return (
    <div className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
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
                'px-4 py-3 text-sm font-medium border-b-2 transition-colors',
                isActive
                  ? 'border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100'
                  : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 hover:border-zinc-300 dark:hover:border-zinc-600',
              ].join(' ')}
              aria-current={isActive ? 'page' : undefined}
            >
              {label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
