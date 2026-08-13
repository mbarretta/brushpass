/**
 * Unit tests for GET /api/cleanup — the hourly Cloud Scheduler cleanup route.
 *
 * google-auth-library's OAuth2Client is instantiated once at module load
 * (`const oidcClient = new OAuth2Client()` in route.ts), so its verifyIdToken
 * method is exposed as a single hoisted mock shared across mocked instances,
 * letting each test configure the OIDC verification outcome independently.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { FileRecord } from '@/types';
import type { AgentDeviceSession } from '@/lib/db';

const { verifyIdTokenMock } = vi.hoisted(() => ({ verifyIdTokenMock: vi.fn() }));

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    verifyIdToken = verifyIdTokenMock;
  },
}));

vi.mock('@/lib/db', () => ({
  getExpiredFiles: vi.fn(),
  deleteFile: vi.fn(),
  getExpiredDeviceSessions: vi.fn(),
  deleteDeviceSession: vi.fn(),
}));

vi.mock('@/lib/gcs', () => ({
  deleteFromGCS: vi.fn(),
}));

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new Request('http://localhost/api/cleanup', { headers }) as unknown as NextRequest;
}

function makeFileRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: 1,
    filename: 'a'.repeat(64) + '.txt',
    original_name: 'test.txt',
    sha256: 'a'.repeat(64),
    size: 4,
    content_type: 'text/plain',
    gcs_key: 'a'.repeat(64) + '.txt',
    token_hash: 'fakehash',
    expires_at: 1,
    uploaded_by: null,
    uploaded_at: 1700000000,
    ...overrides,
  };
}

function makeDeviceSession(overrides: Partial<AgentDeviceSession> = {}): AgentDeviceSession {
  return {
    poll_token_hash: 'hash-1',
    device_code: 'dc-1',
    interval: 5,
    expires_at: 1,
    created_at: 1,
    ...overrides,
  };
}

const ENV_KEYS = ['CLEANUP_SECRET', 'CLEANUP_AUDIENCE', 'CLEANUP_SCHEDULER_SA', 'AUTH_URL'] as const;

describe('GET /api/cleanup', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    const db = await import('@/lib/db');
    vi.mocked(db.getExpiredFiles).mockReturnValue([]);
    vi.mocked(db.getExpiredDeviceSessions).mockReturnValue([]);
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('returns 401 with no Authorization header', async () => {
    const { GET } = await import('@/app/api/cleanup/route');
    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it('fails closed when CLEANUP_SCHEDULER_SA is unset, even for a validly-shaped token', async () => {
    process.env.CLEANUP_AUDIENCE = 'https://cleanup.example.com';
    // CLEANUP_SCHEDULER_SA intentionally left unset.
    verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({ email: 'scheduler@x.iam.gserviceaccount.com' }),
    });

    const { GET } = await import('@/app/api/cleanup/route');
    const res = await GET(makeRequest({ authorization: 'Bearer sometoken' }));

    expect(res.status).toBe(401);
    // Fails closed before ever calling out to Google — the missing SA
    // short-circuits the check instead of silently disabling it.
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it('fails closed when the audience (CLEANUP_AUDIENCE/AUTH_URL) is unset', async () => {
    process.env.CLEANUP_SCHEDULER_SA = 'scheduler@x.iam.gserviceaccount.com';
    // Neither CLEANUP_AUDIENCE nor AUTH_URL is set.
    verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({ email: 'scheduler@x.iam.gserviceaccount.com' }),
    });

    const { GET } = await import('@/app/api/cleanup/route');
    const res = await GET(makeRequest({ authorization: 'Bearer sometoken' }));

    expect(res.status).toBe(401);
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it('rejects a token verified for the wrong service account email', async () => {
    process.env.CLEANUP_AUDIENCE = 'https://cleanup.example.com';
    process.env.CLEANUP_SCHEDULER_SA = 'scheduler@x.iam.gserviceaccount.com';
    verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({ email: 'attacker@evil.com' }),
    });

    const { GET } = await import('@/app/api/cleanup/route');
    const res = await GET(makeRequest({ authorization: 'Bearer sometoken' }));

    expect(res.status).toBe(401);
  });

  it('accepts a token verified for the correct scheduler service account', async () => {
    process.env.CLEANUP_AUDIENCE = 'https://cleanup.example.com';
    process.env.CLEANUP_SCHEDULER_SA = 'scheduler@x.iam.gserviceaccount.com';
    verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({ email: 'scheduler@x.iam.gserviceaccount.com' }),
    });

    const { GET } = await import('@/app/api/cleanup/route');
    const res = await GET(makeRequest({ authorization: 'Bearer sometoken' }));

    expect(res.status).toBe(200);
  });

  it('accepts CLEANUP_SECRET as an alternative to OIDC (local/manual testing)', async () => {
    process.env.CLEANUP_SECRET = 'local-dev-secret';

    const { GET } = await import('@/app/api/cleanup/route');
    const res = await GET(makeRequest({ authorization: 'Bearer local-dev-secret' }));

    expect(res.status).toBe(200);
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it('falls back to AUTH_URL as the audience when CLEANUP_AUDIENCE is unset', async () => {
    process.env.AUTH_URL = 'https://app.example.com';
    process.env.CLEANUP_SCHEDULER_SA = 'scheduler@x.iam.gserviceaccount.com';
    verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({ email: 'scheduler@x.iam.gserviceaccount.com' }),
    });

    const { GET } = await import('@/app/api/cleanup/route');
    const res = await GET(makeRequest({ authorization: 'Bearer sometoken' }));

    expect(res.status).toBe(200);
    expect(verifyIdTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ audience: 'https://app.example.com' }),
    );
  });

  it('prefers CLEANUP_AUDIENCE over AUTH_URL when both are set', async () => {
    process.env.AUTH_URL = 'https://app.example.com';
    process.env.CLEANUP_AUDIENCE = 'https://cleanup.example.com';
    process.env.CLEANUP_SCHEDULER_SA = 'scheduler@x.iam.gserviceaccount.com';
    verifyIdTokenMock.mockResolvedValue({
      getPayload: () => ({ email: 'scheduler@x.iam.gserviceaccount.com' }),
    });

    const { GET } = await import('@/app/api/cleanup/route');
    await GET(makeRequest({ authorization: 'Bearer sometoken' }));

    expect(verifyIdTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ audience: 'https://cleanup.example.com' }),
    );
  });

  describe('expired-file cleanup', () => {
    beforeEach(() => {
      process.env.CLEANUP_SECRET = 'local-dev-secret';
    });

    it('deletes the DB row and counts it as deleted when GCS reports 404 (object already gone)', async () => {
      const db = await import('@/lib/db');
      const gcs = await import('@/lib/gcs');
      const record = makeFileRecord({ id: 42, gcs_key: 'missing-key' });
      vi.mocked(db.getExpiredFiles).mockReturnValue([record]);
      vi.mocked(gcs.deleteFromGCS).mockRejectedValue(
        Object.assign(new Error('Not Found'), { code: 404 }),
      );

      const { GET } = await import('@/app/api/cleanup/route');
      const res = await GET(makeRequest({ authorization: 'Bearer local-dev-secret' }));
      const json = await res.json();

      expect(json.deleted).toBe(1);
      expect(json.errors).toEqual([]);
      expect(db.deleteFile).toHaveBeenCalledWith(42);
    });

    it('leaves the DB row and counts an error for a non-404 GCS failure', async () => {
      const db = await import('@/lib/db');
      const gcs = await import('@/lib/gcs');
      const record = makeFileRecord({ id: 7, gcs_key: 'still-there' });
      vi.mocked(db.getExpiredFiles).mockReturnValue([record]);
      vi.mocked(gcs.deleteFromGCS).mockRejectedValue(
        Object.assign(new Error('Service unavailable'), { code: 500 }),
      );

      const { GET } = await import('@/app/api/cleanup/route');
      const res = await GET(makeRequest({ authorization: 'Bearer local-dev-secret' }));
      const json = await res.json();

      expect(json.deleted).toBe(0);
      expect(json.errors).toHaveLength(1);
      expect(json.errors[0]).toContain('still-there');
      expect(db.deleteFile).not.toHaveBeenCalled();
    });

    it('handles a mix of 404s, failures and successes independently', async () => {
      const db = await import('@/lib/db');
      const gcs = await import('@/lib/gcs');
      const gone = makeFileRecord({ id: 1, gcs_key: 'gone' });
      const broken = makeFileRecord({ id: 2, gcs_key: 'broken' });
      const ok = makeFileRecord({ id: 3, gcs_key: 'ok' });
      vi.mocked(db.getExpiredFiles).mockReturnValue([gone, broken, ok]);
      vi.mocked(gcs.deleteFromGCS).mockImplementation(async (key: string) => {
        if (key === 'gone') throw Object.assign(new Error('Not Found'), { code: 404 });
        if (key === 'broken') throw Object.assign(new Error('boom'), { code: 500 });
      });

      const { GET } = await import('@/app/api/cleanup/route');
      const res = await GET(makeRequest({ authorization: 'Bearer local-dev-secret' }));
      const json = await res.json();

      expect(json.deleted).toBe(2); // gone (404) + ok
      expect(json.errors).toHaveLength(1);
      expect(db.deleteFile).toHaveBeenCalledWith(1);
      expect(db.deleteFile).toHaveBeenCalledWith(3);
      expect(db.deleteFile).not.toHaveBeenCalledWith(2);
    });

    it('prunes expired agent device sessions in the same pass', async () => {
      const db = await import('@/lib/db');
      vi.mocked(db.getExpiredDeviceSessions).mockReturnValue([
        makeDeviceSession({ poll_token_hash: 'hash-1' }),
        makeDeviceSession({ poll_token_hash: 'hash-2' }),
      ]);

      const { GET } = await import('@/app/api/cleanup/route');
      await GET(makeRequest({ authorization: 'Bearer local-dev-secret' }));

      expect(db.deleteDeviceSession).toHaveBeenCalledWith('hash-1');
      expect(db.deleteDeviceSession).toHaveBeenCalledWith('hash-2');
      expect(db.deleteDeviceSession).toHaveBeenCalledTimes(2);
    });
  });
});
