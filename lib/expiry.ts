/**
 * Expiry helpers shared between upload route and tests.
 */

/**
 * Parse a human duration string into a Unix timestamp (seconds).
 *
 * Format: `"Nh"` (N hours from now) or `"Nd"` (N days, expiring at 23:59:59
 * server local time on the Nth day from today).
 *
 * Returns `null` for empty input, malformed input, or N ≤ 0.
 */
export function parseExpiresIn(value: string): number | null {
  if (!value) return null;

  const match = value.match(/^(\d+)([hd])$/);
  if (!match) return null;

  const n = parseInt(match[1], 10);
  if (n <= 0) return null;

  const unit = match[2] as 'h' | 'd';

  if (unit === 'h') {
    return Math.floor(Date.now() / 1000) + n * 3600;
  }

  // Days: expire at 23:59:59 server local time
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(23, 59, 59, 999);
  return Math.floor(d.getTime() / 1000);
}

/**
 * Parse an `expires_at` value that may be either a Unix timestamp string or
 * an ISO 8601 date string into a Unix timestamp (seconds).
 *
 * Returns `null` on empty input or unparseable values.
 */
export function parseExpiresAt(value: string): number | null {
  if (!value) return null;
  // Try as Unix timestamp (numeric string)
  const asNum = Number(value);
  if (!isNaN(asNum) && asNum > 0) return asNum;
  // Try as ISO 8601
  const asDate = new Date(value);
  if (!isNaN(asDate.getTime())) return Math.floor(asDate.getTime() / 1000);
  return null;
}
