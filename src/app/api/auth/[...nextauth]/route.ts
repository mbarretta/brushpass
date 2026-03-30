import { handlers } from '@/auth';

export const { GET, POST } = handlers;

// Do NOT add `export const runtime = "edge"` — this route uses
// the Credentials provider which calls better-sqlite3 (Node-only).
