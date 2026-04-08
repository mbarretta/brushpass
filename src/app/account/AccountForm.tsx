'use client';

import { useState } from 'react';
import type { Permission } from '@/types';

type PasswordState = 'idle' | 'submitting' | 'success' | 'error';

interface Props {
  username: string;
  authProvider: 'credentials' | 'oidc';
  email: string | null;
  permissions: Permission[];
}

const PERMISSION_COLORS: Record<string, string> = {
  upload: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  admin:  'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
};

export default function AccountForm({ username, authProvider, email, permissions }: Props) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword]         = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwState, setPwState]                 = useState<PasswordState>('idle');
  const [pwError, setPwError]                 = useState<string | null>(null);

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault();
    setPwError(null);

    if (newPassword !== confirmPassword) {
      setPwError('New passwords do not match');
      return;
    }
    if (newPassword.length < 8) {
      setPwError('New password must be at least 8 characters');
      return;
    }

    setPwState('submitting');
    try {
      const res = await fetch('/api/account', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (data.ok) {
        setPwState('success');
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        setPwError(data.error ?? 'Failed to change password');
        setPwState('error');
      }
    } catch (err) {
      setPwError(String(err));
      setPwState('error');
    }
  }

  const isCredentials = authProvider === 'credentials';
  const authLabel = isCredentials ? 'Password' : 'SSO / Google';

  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-zinc-950 px-4 py-16">
      <div className="max-w-lg mx-auto space-y-6">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Account</h1>
          <p className="text-sm text-zinc-500 mt-1">Your profile and security settings.</p>
        </div>

        {/* Profile card */}
        <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800">
          <Row label="Username" value={username} />
          <Row label="Sign-in method" value={authLabel} />
          {email && <Row label="Email" value={email} />}
          <div className="px-6 py-4 flex items-center gap-4">
            <span className="text-sm text-zinc-500 w-36 shrink-0">Permissions</span>
            <div className="flex flex-wrap gap-1.5">
              {permissions.length === 0 ? (
                <span className="text-sm text-zinc-400">none</span>
              ) : (
                permissions.map((p) => (
                  <span
                    key={p}
                    className={`text-xs font-medium px-2 py-0.5 rounded-full ${PERMISSION_COLORS[p] ?? 'bg-zinc-100 text-zinc-700'}`}
                  >
                    {p}
                  </span>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Password change */}
        <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 p-6">
          <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-100 mb-4">
            Change Password
          </h2>

          {isCredentials ? (
            <form onSubmit={handlePasswordChange} className="space-y-4">
              <Field
                label="Current password"
                type="password"
                value={currentPassword}
                onChange={setCurrentPassword}
                disabled={pwState === 'submitting'}
                autoComplete="current-password"
              />
              <Field
                label="New password"
                type="password"
                value={newPassword}
                onChange={setNewPassword}
                disabled={pwState === 'submitting'}
                autoComplete="new-password"
              />
              <Field
                label="Confirm new password"
                type="password"
                value={confirmPassword}
                onChange={setConfirmPassword}
                disabled={pwState === 'submitting'}
                autoComplete="new-password"
              />

              {pwState === 'success' && (
                <p className="text-sm text-green-600 dark:text-green-400">Password changed successfully.</p>
              )}
              {(pwState === 'error' || pwError) && pwError && (
                <p className="text-sm text-red-600 dark:text-red-400">{pwError}</p>
              )}

              <button
                type="submit"
                disabled={pwState === 'submitting' || !currentPassword || !newPassword || !confirmPassword}
                className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm font-medium px-4 py-2 hover:bg-zinc-700 dark:hover:bg-zinc-300 disabled:opacity-50 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2"
              >
                {pwState === 'submitting' ? 'Saving…' : 'Change Password'}
              </button>
            </form>
          ) : (
            <p className="text-sm text-zinc-500">
              Password authentication is not available for SSO accounts. Manage your password
              through your identity provider.
            </p>
          )}
        </div>

      </div>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-6 py-4 flex items-center gap-4">
      <span className="text-sm text-zinc-500 w-36 shrink-0">{label}</span>
      <span className="text-sm text-zinc-900 dark:text-zinc-100 font-medium">{value}</span>
    </div>
  );
}

function Field({
  label, type, value, onChange, disabled, autoComplete,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  autoComplete?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        autoComplete={autoComplete}
        className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50"
      />
    </div>
  );
}
