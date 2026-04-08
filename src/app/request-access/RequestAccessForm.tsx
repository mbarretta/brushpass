'use client';

import { useState } from 'react';
import type { Permission } from '@/types';

const ALL_PERMISSIONS: Permission[] = ['upload', 'admin'];

type FormState = 'idle' | 'submitting' | 'submitted' | 'error';

export default function RequestAccessForm() {
  const [selectedPermissions, setSelectedPermissions] = useState<Permission[]>([]);
  const [formState, setFormState] = useState<FormState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function togglePermission(p: Permission) {
    setSelectedPermissions((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormState('submitting');
    setErrorMessage(null);
    try {
      const res = await fetch('/api/permission-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions: selectedPermissions }),
      });
      const data = await res.json();
      if (data.ok) {
        setFormState('submitted');
      } else {
        setErrorMessage(data.error ?? 'Failed to submit request');
        setFormState('error');
      }
    } catch (err) {
      setErrorMessage(String(err));
      setFormState('error');
    }
  }

  if (formState === 'submitted') {
    return (
      <main className="min-h-screen bg-zinc-50 flex items-center justify-center px-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-zinc-200 p-10 flex flex-col items-center text-center gap-4">
          <h1 className="text-xl font-semibold text-zinc-900">Request Submitted</h1>
          <p className="text-sm text-zinc-600">
            Your access request has been submitted. Sign out and back in once your request has been
            approved.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-zinc-200 p-10">
        <h1 className="text-2xl font-semibold text-zinc-900 mb-1">Request Access</h1>
        <p className="text-sm text-zinc-500 mb-6">
          Select the permissions you need and submit a request.
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <span className="block text-sm font-medium text-zinc-700 mb-2">Permissions</span>
            <div className="flex flex-col gap-2">
              {ALL_PERMISSIONS.map((p) => (
                <label key={p} className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={selectedPermissions.includes(p)}
                    onChange={() => togglePermission(p)}
                    className="rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
                  />
                  <span className="text-sm text-zinc-700">{p}</span>
                </label>
              ))}
            </div>
          </div>

          {(formState === 'error') && errorMessage && (
            <p className="text-sm text-red-600">{errorMessage}</p>
          )}

          <button
            type="submit"
            disabled={formState === 'submitting' || selectedPermissions.length === 0}
            className="w-full rounded-lg bg-zinc-900 text-white text-sm font-medium px-4 py-2 hover:bg-zinc-700 disabled:opacity-50 transition-colors focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2"
          >
            {formState === 'submitting' ? 'Submitting…' : 'Request Access'}
          </button>
        </form>
      </div>
    </main>
  );
}
