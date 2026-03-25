import { describe, it, expect, beforeEach } from 'vitest';

// Set DATABASE_PATH before any db import so getDb() opens :memory: instead of the real file.
// This must be done at module scope, before the lazy import below.
process.env.DATABASE_PATH = ':memory:';

import { _resetDb, insertFile, getFileById, updateFileTokenHash } from '@/lib/db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFileData(overrides: Partial<Parameters<typeof insertFile>[0]> = {}) {
  return {
    filename: 'test-file.txt',
    original_name: 'test file.txt',
    md5: 'abc123def456abc123def456abc12345',
    size: 1024,
    content_type: 'text/plain',
    gcs_key: 'uploads/test-file.txt',
    token_hash: '$2b$initial_hash',
    expires_at: null,
    uploaded_by: 'admin',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// updateFileTokenHash
// ---------------------------------------------------------------------------

describe('updateFileTokenHash', () => {
  beforeEach(() => {
    _resetDb();
  });

  it('updates token_hash for an existing file', () => {
    const file = insertFile(makeFileData({ token_hash: '$2b$old_hash' }));
    updateFileTokenHash(file.id, '$2b$new_hash');
    const updated = getFileById(file.id);
    expect(updated?.token_hash).toBe('$2b$new_hash');
  });

  it('does not throw for a nonexistent id (no-op)', () => {
    expect(() => updateFileTokenHash(9999, '$2b$x')).not.toThrow();
  });

  it('leaves other fields unchanged after update', () => {
    const file = insertFile(makeFileData({ original_name: 'unchanged.txt', size: 512 }));
    updateFileTokenHash(file.id, '$2b$updated_hash');
    const updated = getFileById(file.id);
    expect(updated?.original_name).toBe('unchanged.txt');
    expect(updated?.size).toBe(512);
    expect(updated?.token_hash).toBe('$2b$updated_hash');
  });

  it('can update the same file twice', () => {
    const file = insertFile(makeFileData({ token_hash: '$2b$v1' }));
    updateFileTokenHash(file.id, '$2b$v2');
    updateFileTokenHash(file.id, '$2b$v3');
    const updated = getFileById(file.id);
    expect(updated?.token_hash).toBe('$2b$v3');
  });
});
