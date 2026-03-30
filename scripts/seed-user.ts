/**
 * Seed script: inserts testuser and admin into the SQLite DB.
 * Run from the project root:
 *   npx tsx scripts/seed-user.ts
 */
import path from 'path';
import { fileURLToPath } from 'url';

// Resolve project root so DATABASE_PATH is consistent with the app
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Set DATABASE_PATH if not already set — matches app default
if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = path.join(projectRoot, 'src', 'data', 'fileshare.db');
}

// Dynamic imports keep this ESM-compatible with tsx
const { getDb } = await import('../src/lib/db.js');
const { hashToken } = await import('../src/lib/token.js');

const db = getDb();

const users = [
  { username: 'testuser', password: 'testpass', permissions: ['upload'] },
  { username: 'admin', password: 'adminpass', permissions: ['admin', 'upload'] },
];

const upsert = db.prepare<[string, string, string]>(`
  INSERT INTO users (username, password_hash, permissions)
  VALUES (?, ?, ?)
  ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, permissions = excluded.permissions
`);

for (const { username, password, permissions } of users) {
  const hash = await hashToken(password);
  upsert.run(username, hash, JSON.stringify(permissions));
  console.log(`[seed] upserted user=${username} permissions=${JSON.stringify(permissions)}`);
}

console.log('[seed] done');
