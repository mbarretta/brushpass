export type Permission = 'upload' | 'admin';

export interface FileRecord {
  id: number;
  filename: string;       // GCS key: <md5>.<ext>
  original_name: string;
  md5: string;
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
  password_hash: string;
  permissions: Permission[];  // stored as JSON text in DB
  created_at: number;
}
