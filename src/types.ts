export type Permission = 'upload' | 'admin';

export interface FileRecord {
  id: number;
  filename: string;       // GCS key: <sha256>.<ext>
  original_name: string;
  sha256: string;
  size: number;
  content_type: string;
  gcs_key: string;
  token_hash: string;
  expires_at: number | null;  // Unix timestamp, null = no expiry
  uploaded_at: number;
  uploaded_by: string | null;
}

export interface DownloadLog {
  id: number;
  file_id: number;
  downloaded_at: number;
}

export interface User {
  id: number;
  username: string;
  password_hash: string | null;
  email: string | null;
  auth_provider: 'credentials' | 'oidc';
  permissions: Permission[];  // stored as JSON text in DB
  created_at: number;
}

export interface PermissionRequest {
  id: number;
  user_id: number;
  username: string;
  email: string | null;
  requested_permissions: Permission[];
  requested_at: number;
}

export interface FileGroup {
  id: number;
  name: string;
  slug: string;
  token_hash: string;
  expires_at: number | null;
  created_by: string | null;
  created_at: number;
}

export interface FileGroupMember {
  group_id: number;
  file_id: number;
  added_at: number;
}

export interface FileGroupWithFiles extends FileGroup {
  files: FileRecord[];
}

// ── Safe projections ─────────────────────────────────────────────────────────
// These are the shapes actually returned by db.ts's projected getters — the
// secret column is never selected, so it's absent rather than stripped. The
// full interfaces above are unchanged and still back insert/update payloads,
// the *ForAuth getters, and existing test fixtures.

export type SafeFileRecord = Omit<FileRecord, 'token_hash'>;
export type SafeFileGroup = Omit<FileGroup, 'token_hash'>;
export type SafeUser = Omit<User, 'password_hash'>;

export interface SafeFileGroupWithFiles extends SafeFileGroup {
  files: SafeFileRecord[];
}

/** Minimal public-safe file shape returned by the anonymous group-access route. */
export interface PublicGroupFile {
  sha256: string;
  original_name: string;
  size: number;
  content_type: string;
}
