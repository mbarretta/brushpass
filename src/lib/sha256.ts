export function isValidSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

/**
 * Validate and lowercase a candidate sha256 digest. Returns null for an
 * invalid value. Lowercasing here (not just checking case-insensitively)
 * matters: an uppercase digest for content that already exists must
 * resolve to the same row as the original lowercase digest, so the caller
 * takes the collision branch instead of creating a duplicate row (and a
 * second token) for identical content.
 */
export function normalizeSha256(value: string): string | null {
  if (!isValidSha256(value)) return null;
  return value.toLowerCase();
}
