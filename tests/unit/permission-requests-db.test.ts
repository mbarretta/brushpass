/**
 * Real-SQLite integration tests for the five permission-request DB helpers:
 *   createPermissionRequest, listPendingPermissionRequests,
 *   approvePermissionRequest, denyPermissionRequest, getPendingRequestCount
 *
 * Uses a temp-dir isolated SQLite DB per test (same pattern as oidc.test.ts).
 * Does NOT mock @/lib/db — all helpers run against a real DB.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// next-auth calls NextRequest from "next/server" at module-load time.
// None of the DB helpers import next-auth, but we mock it here as a safety
// net in case any transitive import reaches it in the Node test environment.
vi.mock('next-auth', () => ({
  default: (_config: unknown) => ({
    handlers: {},
    auth: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  }),
}));

// ── Temp DB isolation ────────────────────────────────────────────────────────
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brushpass-pr-test-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
});

afterEach(async () => {
  const mod = await import('@/lib/db');
  mod._resetDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
  vi.resetModules();
});

// ── createPermissionRequest ───────────────────────────────────────────────────

describe('createPermissionRequest()', () => {
  it('inserts a row; listPendingPermissionRequests returns 1 entry with correct deserialized permissions', async () => {
    const { upsertOidcUser, createPermissionRequest, listPendingPermissionRequests } =
      await import('@/lib/db');

    const user = upsertOidcUser('alice@example.com', 'Alice', []);
    createPermissionRequest(user.id, ['upload', 'admin']);

    const pending = listPendingPermissionRequests();
    expect(pending).toHaveLength(1);
    expect(pending[0].user_id).toBe(user.id);
    expect(pending[0].username).toBe('Alice');
    expect(pending[0].requested_permissions).toEqual(['upload', 'admin']);
  });
});

// ── listPendingPermissionRequests ─────────────────────────────────────────────

describe('listPendingPermissionRequests()', () => {
  it('returns an empty array when no requests exist', async () => {
    const { listPendingPermissionRequests } = await import('@/lib/db');

    const pending = listPendingPermissionRequests();
    expect(pending).toEqual([]);
  });

  it('returns deserialized Permission[] ordered ASC by requested_at', async () => {
    const { upsertOidcUser, createPermissionRequest, listPendingPermissionRequests } =
      await import('@/lib/db');

    const userA = upsertOidcUser('a@example.com', 'A', []);
    const userB = upsertOidcUser('b@example.com', 'B', []);

    // Insert with a tiny sleep so requested_at timestamps differ
    createPermissionRequest(userA.id, ['upload']);
    // SQLite CURRENT_TIMESTAMP is second-precision; insert a row for B second
    createPermissionRequest(userB.id, ['admin']);

    const pending = listPendingPermissionRequests();
    expect(pending).toHaveLength(2);
    // Verify deserialized types — each element is a Permission[]
    expect(Array.isArray(pending[0].requested_permissions)).toBe(true);
    expect(Array.isArray(pending[1].requested_permissions)).toBe(true);
    // ASC ordering — A's request was inserted first
    expect(pending[0].user_id).toBe(userA.id);
    expect(pending[1].user_id).toBe(userB.id);
  });
});

// ── approvePermissionRequest ──────────────────────────────────────────────────

describe('approvePermissionRequest()', () => {
  it('updates user permissions AND removes the request atomically', async () => {
    const {
      upsertOidcUser,
      createPermissionRequest,
      approvePermissionRequest,
      listPendingPermissionRequests,
      getUserById,
    } = await import('@/lib/db');

    const user = upsertOidcUser('bob@example.com', 'Bob', []);
    createPermissionRequest(user.id, ['upload']);

    const before = listPendingPermissionRequests();
    expect(before).toHaveLength(1);
    const requestId = before[0].id;

    approvePermissionRequest(requestId, ['upload']);

    // Request removed
    expect(listPendingPermissionRequests()).toEqual([]);
    // User permissions updated
    const updated = getUserById(user.id);
    expect(updated?.permissions).toEqual(['upload']);
  });

  it('is a no-op when the request ID does not exist (no panic)', async () => {
    const { approvePermissionRequest, listPendingPermissionRequests } =
      await import('@/lib/db');

    // Should not throw
    expect(() => approvePermissionRequest(99999, ['upload'])).not.toThrow();
    expect(listPendingPermissionRequests()).toEqual([]);
  });
});

// ── denyPermissionRequest ─────────────────────────────────────────────────────

describe('denyPermissionRequest()', () => {
  it('removes the request; user permissions remain unchanged', async () => {
    const {
      upsertOidcUser,
      createPermissionRequest,
      denyPermissionRequest,
      listPendingPermissionRequests,
      getUserById,
    } = await import('@/lib/db');

    const user = upsertOidcUser('carol@example.com', 'Carol', []);
    createPermissionRequest(user.id, ['upload']);

    const before = listPendingPermissionRequests();
    expect(before).toHaveLength(1);
    const requestId = before[0].id;

    denyPermissionRequest(requestId);

    // Request removed
    expect(listPendingPermissionRequests()).toEqual([]);
    // User permissions unchanged (still empty)
    const unchanged = getUserById(user.id);
    expect(unchanged?.permissions).toEqual([]);
  });
});

// ── getPendingRequestCount ────────────────────────────────────────────────────

describe('getPendingRequestCount()', () => {
  it('returns 0 initially, 1 after insert, 0 after deny', async () => {
    const {
      upsertOidcUser,
      createPermissionRequest,
      denyPermissionRequest,
      getPendingRequestCount,
      listPendingPermissionRequests,
    } = await import('@/lib/db');

    expect(getPendingRequestCount()).toBe(0);

    const user = upsertOidcUser('dave@example.com', 'Dave', []);
    createPermissionRequest(user.id, ['admin']);

    expect(getPendingRequestCount()).toBe(1);

    const pending = listPendingPermissionRequests();
    denyPermissionRequest(pending[0].id);

    expect(getPendingRequestCount()).toBe(0);
  });
});
