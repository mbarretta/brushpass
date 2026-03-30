'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Permission } from '@/types';

interface AdminUserActionsProps {
  userId: number;
  username: string;
  permissions: Permission[];
}

const ALL_PERMISSIONS: Permission[] = ['upload', 'admin'];

export default function AdminUserActions({
  userId,
  username: initialUsername,
  permissions: initialPermissions,
}: AdminUserActionsProps) {
  const router = useRouter();

  // Username edit
  const [newUsername, setNewUsername] = useState(initialUsername);
  const [savingUsername, setSavingUsername] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);

  // Password reset
  const [newPassword, setNewPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  // Permissions
  const [currentPermissions, setCurrentPermissions] = useState<Permission[]>(initialPermissions);
  const [savingPermissions, setSavingPermissions] = useState(false);
  const [permissionsError, setPermissionsError] = useState<string | null>(null);

  // Delete
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleSaveUsername() {
    setSavingUsername(true);
    setUsernameError(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newUsername }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setUsernameError(data.error ?? 'Failed to update username');
      } else {
        router.refresh();
      }
    } catch (err) {
      setUsernameError(String(err));
    } finally {
      setSavingUsername(false);
    }
  }

  async function handleResetPassword() {
    if (!newPassword) {
      setPasswordError('Password cannot be empty');
      return;
    }
    setSavingPassword(true);
    setPasswordError(null);
    setPasswordSuccess(false);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPassword }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setPasswordError(data.error ?? 'Failed to reset password');
      } else {
        setNewPassword('');
        setPasswordSuccess(true);
        router.refresh();
      }
    } catch (err) {
      setPasswordError(String(err));
    } finally {
      setSavingPassword(false);
    }
  }

  function togglePermission(p: Permission) {
    setCurrentPermissions((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
    );
  }

  async function handleSavePermissions() {
    setSavingPermissions(true);
    setPermissionsError(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions: currentPermissions }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setPermissionsError(data.error ?? 'Failed to update permissions');
      } else {
        router.refresh();
      }
    } catch (err) {
      setPermissionsError(String(err));
    } finally {
      setSavingPermissions(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete user "${initialUsername}"? This cannot be undone.`)) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setDeleteError(data.error ?? 'Failed to delete user');
        setDeleting(false);
      } else {
        router.push('/admin/users');
      }
    } catch (err) {
      setDeleteError(String(err));
      setDeleting(false);
    }
  }

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-6 space-y-6">
      {/* Edit Username */}
      <div>
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 mb-3">
          Edit Username
        </h2>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="text"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-200 flex-1 min-w-0"
          />
          <button
            onClick={handleSaveUsername}
            disabled={savingUsername}
            className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm font-medium px-4 py-2 hover:bg-zinc-700 dark:hover:bg-zinc-300 disabled:opacity-50 transition-colors shrink-0"
          >
            {savingUsername ? 'Saving…' : 'Save'}
          </button>
        </div>
        {usernameError && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{usernameError}</p>
        )}
      </div>

      {/* Reset Password */}
      <div className="border-t border-zinc-100 dark:border-zinc-800 pt-6">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 mb-3">
          Reset Password
        </h2>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="password"
            value={newPassword}
            onChange={(e) => {
              setNewPassword(e.target.value);
              setPasswordSuccess(false);
            }}
            placeholder="New password"
            className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-200 flex-1 min-w-0"
          />
          <button
            onClick={handleResetPassword}
            disabled={savingPassword}
            className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm font-medium px-4 py-2 hover:bg-zinc-700 dark:hover:bg-zinc-300 disabled:opacity-50 transition-colors shrink-0"
          >
            {savingPassword ? 'Saving…' : 'Reset'}
          </button>
        </div>
        {passwordError && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{passwordError}</p>
        )}
        {passwordSuccess && (
          <p className="mt-2 text-sm text-green-600 dark:text-green-400">Password updated.</p>
        )}
      </div>

      {/* Permissions */}
      <div className="border-t border-zinc-100 dark:border-zinc-800 pt-6">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 mb-3">
          Permissions
        </h2>
        <div className="flex flex-col gap-2 mb-4">
          {ALL_PERMISSIONS.map((p) => (
            <label key={p} className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={currentPermissions.includes(p)}
                onChange={() => togglePermission(p)}
                className="rounded border-zinc-300 dark:border-zinc-700 text-zinc-900 focus:ring-zinc-900 dark:focus:ring-zinc-200"
              />
              <span className="text-sm text-zinc-700 dark:text-zinc-300">{p}</span>
            </label>
          ))}
        </div>
        <button
          onClick={handleSavePermissions}
          disabled={savingPermissions}
          className="rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-sm font-medium px-4 py-2 hover:bg-zinc-700 dark:hover:bg-zinc-300 disabled:opacity-50 transition-colors"
        >
          {savingPermissions ? 'Saving…' : 'Save Permissions'}
        </button>
        {permissionsError && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{permissionsError}</p>
        )}
      </div>

      {/* Danger Zone */}
      <div className="border-t border-zinc-100 dark:border-zinc-800 pt-6">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 mb-3">
          Danger Zone
        </h2>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="rounded-lg bg-red-600 text-white text-sm font-medium px-4 py-2 hover:bg-red-700 disabled:opacity-50 transition-colors"
        >
          {deleting ? 'Deleting…' : 'Delete User'}
        </button>
        {deleteError && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{deleteError}</p>
        )}
      </div>
    </div>
  );
}
