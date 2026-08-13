/**
 * Unit tests for file group DB helpers.
 * Uses an in-memory SQLite DB via DATABASE_PATH=:memory:.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Use in-memory DB for all tests
process.env.DATABASE_PATH = ':memory:';

import {
  _resetDb,
  insertGroup,
  getGroupBySlug,
  getGroupBySlugForAuth,
  getGroupById,
  getGroupNameBySlug,
  getGroupsForFile,
  listGroups,
  updateGroup,
  deleteGroup,
  addFileToGroup,
  removeFileFromGroup,
  listGroupFiles,
  getGroupWithFiles,
  isValidSlug,
  insertFile,
  getFileById,
} from '@/lib/db';

const BASE_GROUP = {
  name: 'Test Group',
  slug: 'test-group',
  token_hash: '$2b$10$fakehash000000000000000000000000000000000000000000000',
  expires_at: null,
  created_by: 'admin',
};

const BASE_FILE = {
  filename: 'abc123.pdf',
  original_name: 'report.pdf',
  sha256: 'a'.repeat(64),
  size: 1024,
  content_type: 'application/pdf',
  gcs_key: 'abc123.pdf',
  token_hash: '$2b$10$fakehash000000000000000000000000000000000000000000001',
  expires_at: null,
  uploaded_by: null,
};

beforeEach(() => {
  _resetDb();
});

describe('isValidSlug', () => {
  it('accepts single lowercase letter', () => expect(isValidSlug('a')).toBe(true));
  it('accepts lowercase alphanumeric with hyphens', () => expect(isValidSlug('my-group-1')).toBe(true));
  it('rejects empty string', () => expect(isValidSlug('')).toBe(false));
  it('rejects uppercase', () => expect(isValidSlug('MyGroup')).toBe(false));
  it('rejects leading hyphen', () => expect(isValidSlug('-group')).toBe(false));
  it('rejects trailing hyphen', () => expect(isValidSlug('group-')).toBe(false));
  it('rejects spaces', () => expect(isValidSlug('my group')).toBe(false));
  it('rejects string longer than 64 chars', () => expect(isValidSlug('a'.repeat(65))).toBe(false));
  it('accepts exactly 64 chars', () => expect(isValidSlug('a'.repeat(64))).toBe(true));
});

describe('insertGroup', () => {
  it('creates a group and returns the record', () => {
    const group = insertGroup(BASE_GROUP);
    expect(group.id).toBeTypeOf('number');
    expect(group.name).toBe('Test Group');
    expect(group.slug).toBe('test-group');
    expect(group.token_hash).toBe(BASE_GROUP.token_hash);
    expect(group.expires_at).toBeNull();
    expect(group.created_by).toBe('admin');
    expect(group.created_at).toBeTypeOf('number');
  });

  it('throws on duplicate slug (UNIQUE constraint)', () => {
    insertGroup(BASE_GROUP);
    expect(() => insertGroup({ ...BASE_GROUP })).toThrow();
  });
});

describe('getGroupBySlug', () => {
  it('returns the group for a known slug', () => {
    insertGroup(BASE_GROUP);
    const group = getGroupBySlug('test-group');
    expect(group).toBeDefined();
    expect(group!.name).toBe('Test Group');
    expect(group).not.toHaveProperty('token_hash');
  });

  it('returns undefined for unknown slug', () => {
    expect(getGroupBySlug('no-such-group')).toBeUndefined();
  });
});

describe('getGroupBySlugForAuth', () => {
  it('includes token_hash', () => {
    insertGroup(BASE_GROUP);
    const group = getGroupBySlugForAuth('test-group');
    expect(group?.token_hash).toBe(BASE_GROUP.token_hash);
  });

  it('returns undefined for unknown slug', () => {
    expect(getGroupBySlugForAuth('no-such-group')).toBeUndefined();
  });
});

describe('getGroupById', () => {
  it('returns the group for a known id', () => {
    const created = insertGroup(BASE_GROUP);
    const found = getGroupById(created.id);
    expect(found).toBeDefined();
    expect(found!.slug).toBe('test-group');
    expect(found).not.toHaveProperty('token_hash');
  });

  it('returns undefined for unknown id', () => {
    expect(getGroupById(999)).toBeUndefined();
  });
});

describe('getGroupNameBySlug', () => {
  it('returns only the name and expiry for a known slug', () => {
    insertGroup(BASE_GROUP);
    const projected = getGroupNameBySlug('test-group');
    expect(projected).toEqual({ name: 'Test Group', expires_at: null });
  });

  it('returns undefined for unknown slug', () => {
    expect(getGroupNameBySlug('no-such-group')).toBeUndefined();
  });
});

describe('listGroups', () => {
  it('returns empty array when no groups', () => {
    expect(listGroups()).toHaveLength(0);
  });

  it('returns all groups with member_count', () => {
    const g = insertGroup(BASE_GROUP);
    insertGroup({ ...BASE_GROUP, slug: 'second-group', name: 'Second' });
    const file = insertFile(BASE_FILE);
    addFileToGroup(g.id, file.id);

    const groups = listGroups();
    expect(groups).toHaveLength(2);
    const first = groups.find(gr => gr.slug === 'test-group')!;
    expect(first.member_count).toBe(1);
    const second = groups.find(gr => gr.slug === 'second-group')!;
    expect(second.member_count).toBe(0);
    expect(groups.every((gr) => !('token_hash' in gr))).toBe(true);
  });
});

describe('getGroupsForFile', () => {
  it('returns the groups a file belongs to, without token_hash', () => {
    const g = insertGroup(BASE_GROUP);
    const file = insertFile(BASE_FILE);
    addFileToGroup(g.id, file.id);

    const groups = getGroupsForFile(file.id);
    expect(groups).toHaveLength(1);
    expect(groups[0].slug).toBe('test-group');
    expect(groups[0]).not.toHaveProperty('token_hash');
  });

  it('returns an empty array for a file in no groups', () => {
    const file = insertFile(BASE_FILE);
    expect(getGroupsForFile(file.id)).toHaveLength(0);
  });
});

describe('updateGroup', () => {
  it('renames the group', () => {
    const g = insertGroup(BASE_GROUP);
    updateGroup(g.id, { name: 'Renamed' });
    expect(getGroupById(g.id)!.name).toBe('Renamed');
  });

  it('updates the slug', () => {
    const g = insertGroup(BASE_GROUP);
    updateGroup(g.id, { slug: 'new-slug' });
    expect(getGroupById(g.id)!.slug).toBe('new-slug');
    expect(getGroupBySlug('new-slug')).toBeDefined();
    expect(getGroupBySlug('test-group')).toBeUndefined();
  });

  it('sets expires_at', () => {
    const g = insertGroup(BASE_GROUP);
    updateGroup(g.id, { expires_at: 9999999 });
    expect(getGroupById(g.id)!.expires_at).toBe(9999999);
  });

  it('clears expires_at to null', () => {
    const g = insertGroup({ ...BASE_GROUP, expires_at: 9999999 });
    updateGroup(g.id, { expires_at: null });
    expect(getGroupById(g.id)!.expires_at).toBeNull();
  });

  it('is a no-op with empty patch', () => {
    const g = insertGroup(BASE_GROUP);
    expect(() => updateGroup(g.id, {})).not.toThrow();
    expect(getGroupById(g.id)!.name).toBe('Test Group');
  });
});

describe('deleteGroup', () => {
  it('removes the group', () => {
    const g = insertGroup(BASE_GROUP);
    deleteGroup(g.id);
    expect(getGroupById(g.id)).toBeUndefined();
  });

  it('cascades to members', () => {
    const g = insertGroup(BASE_GROUP);
    const file = insertFile(BASE_FILE);
    addFileToGroup(g.id, file.id);
    deleteGroup(g.id);
    // Re-insert same group — members should be gone (cascade worked)
    const g2 = insertGroup(BASE_GROUP);
    expect(listGroupFiles(g2.id)).toHaveLength(0);
    // File itself is still in the DB (group delete does not delete files)
    expect(getFileById(file.id)).toBeDefined();
  });
});

describe('addFileToGroup / removeFileFromGroup / listGroupFiles', () => {
  it('adds a file to a group', () => {
    const g = insertGroup(BASE_GROUP);
    const f = insertFile(BASE_FILE);
    addFileToGroup(g.id, f.id);
    const files = listGroupFiles(g.id);
    expect(files).toHaveLength(1);
    expect(files[0].sha256).toBe(BASE_FILE.sha256);
  });

  it('is idempotent (INSERT OR IGNORE)', () => {
    const g = insertGroup(BASE_GROUP);
    const f = insertFile(BASE_FILE);
    addFileToGroup(g.id, f.id);
    addFileToGroup(g.id, f.id);
    expect(listGroupFiles(g.id)).toHaveLength(1);
  });

  it('removes a file from a group', () => {
    const g = insertGroup(BASE_GROUP);
    const f = insertFile(BASE_FILE);
    addFileToGroup(g.id, f.id);
    removeFileFromGroup(g.id, f.id);
    expect(listGroupFiles(g.id)).toHaveLength(0);
  });

  it('returns empty array for group with no members', () => {
    const g = insertGroup(BASE_GROUP);
    expect(listGroupFiles(g.id)).toHaveLength(0);
  });
});

describe('getGroupWithFiles', () => {
  it('returns group with files array, and neither the group nor its files carry token_hash', () => {
    const g = insertGroup(BASE_GROUP);
    const f = insertFile(BASE_FILE);
    addFileToGroup(g.id, f.id);
    const result = getGroupWithFiles('test-group');
    expect(result).toBeDefined();
    expect(result!.name).toBe('Test Group');
    expect(result!.files).toHaveLength(1);
    expect(result!.files[0].sha256).toBe(BASE_FILE.sha256);
    expect(result).not.toHaveProperty('token_hash');
    expect(result!.files[0]).not.toHaveProperty('token_hash');
  });

  it('returns group with empty files array when no members', () => {
    insertGroup(BASE_GROUP);
    const result = getGroupWithFiles('test-group');
    expect(result).toBeDefined();
    expect(result!.files).toHaveLength(0);
    expect(result).not.toHaveProperty('token_hash');
  });

  it('returns undefined for unknown slug', () => {
    expect(getGroupWithFiles('no-such-slug')).toBeUndefined();
  });
});
