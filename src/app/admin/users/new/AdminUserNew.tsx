'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Permission } from '@/types';

const ALL_PERMISSIONS: Permission[] = ['upload', 'admin'];

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*-_+=?';
const PASSWORD_LENGTH = 20;

function generateSecurePassword(): string {
  const bytes = new Uint8Array(PASSWORD_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => CHARSET[b % CHARSET.length])
    .join('');
}

export default function AdminUserNew() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // null = user typed manually; non-null = generated (tracks current generated value for copy)
  const [generatedPassword, setGeneratedPassword] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function togglePermission(p: Permission) {
    setPermissions((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
    );
  }

  function handleGeneratePassword() {
    const pwd = generateSecurePassword();
    setPassword(pwd);
    setGeneratedPassword(pwd);
    setCopied(false);
  }

  async function handleCopyCredentials() {
    if (!generatedPassword || !username) return;
    const text = `Username: ${username}\nPassword: ${generatedPassword}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — silently ignore
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, permissions }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Failed to create user');
      } else {
        router.push('/admin/users');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 px-4 py-10">
      <div className="max-w-md mx-auto">
        <div className="mb-6">
          <Link href="/admin/users" className="text-sm text-zinc-500 hover:underline">
            ← Users
          </Link>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mt-1">
            New User
          </h1>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-6 space-y-5"
        >
          <div>
            <label
              htmlFor="username"
              className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1"
            >
              Username
            </label>
            <input
              id="username"
              type="text"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-200"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1"
            >
              Password
            </label>
            <input
              id="password"
              // Show generated password in plaintext so admin can review/copy it;
              // keep manual typing hidden as a normal password field.
              type={generatedPassword !== null ? 'text' : 'password'}
              required
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                // Manual edit clears the generated state — copy button hides.
                setGeneratedPassword(null);
                setCopied(false);
              }}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm font-mono text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-200"
            />
            <div className="mt-2 flex flex-col gap-2">
              <button
                type="button"
                onClick={handleGeneratePassword}
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400"
              >
                Generate password
              </button>
              {generatedPassword !== null && (
                <button
                  type="button"
                  onClick={handleCopyCredentials}
                  disabled={!username}
                  className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-400"
                >
                  {copied ? '✓ Copied!' : 'Copy credentials'}
                </button>
              )}
            </div>
          </div>

          <div>
            <span className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
              Permissions
            </span>
            <div className="flex flex-col gap-2">
              {ALL_PERMISSIONS.map((p) => (
                <label key={p} className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={permissions.includes(p)}
                    onChange={() => togglePermission(p)}
                    className="rounded border-zinc-300 dark:border-zinc-700 text-zinc-900 focus:ring-zinc-900 dark:focus:ring-zinc-200"
                  />
                  <span className="text-sm text-zinc-700 dark:text-zinc-300">{p}</span>
                </label>
              ))}
            </div>
          </div>

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm font-medium px-4 py-2 hover:bg-zinc-700 dark:hover:bg-zinc-300 disabled:opacity-50 transition-colors"
          >
            {submitting ? 'Creating…' : 'Create User'}
          </button>
        </form>
      </div>
    </div>
  );
}
