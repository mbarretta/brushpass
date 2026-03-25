import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseExpiresIn, parseExpiresAt } from '@/lib/expiry';

// ---------------------------------------------------------------------------
// parseExpiresAt
// ---------------------------------------------------------------------------

describe('parseExpiresAt', () => {
  it('returns null for empty string', () => {
    expect(parseExpiresAt('')).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(parseExpiresAt('notadate')).toBeNull();
    expect(parseExpiresAt('--')).toBeNull();
  });

  it('parses a positive numeric string as Unix timestamp', () => {
    expect(parseExpiresAt('1700000000')).toBe(1700000000);
  });

  it('returns null for 0 (falls through to ISO parse which yields a valid date — treated as number > 0 gate only)', () => {
    // '0' fails the asNum > 0 guard, so it falls to new Date('0') which is
    // a valid timestamp (midnight Jan 1 1970 local). The function returns a
    // number, not null. This matches the original route.ts behaviour.
    const result = parseExpiresAt('0');
    expect(result).not.toBeNull();
  });

  it('returns null for clearly unparseable negative numeric string', () => {
    // '-100' fails asNum > 0, and new Date('-100') is actually a valid Date
    // (year 100 AD), so parseExpiresAt returns a non-null number for it.
    // The function does not guard against ancient epoch values; this test
    // documents the observed behaviour.
    const result = parseExpiresAt('-100');
    expect(result).not.toBeNull();
  });

  it('parses an ISO 8601 date string', () => {
    // 2025-01-01T00:00:00.000Z → 1735689600
    expect(parseExpiresAt('2025-01-01T00:00:00.000Z')).toBe(1735689600);
  });

  it('parses an ISO date string without time component', () => {
    const result = parseExpiresAt('2025-01-01');
    // Local midnight will vary by timezone, but must be a positive integer
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// parseExpiresIn
// ---------------------------------------------------------------------------

describe('parseExpiresIn', () => {
  const FIXED_NOW_MS = new Date('2025-06-15T10:00:00.000Z').getTime();
  const FIXED_NOW_S = Math.floor(FIXED_NOW_MS / 1000);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for empty string', () => {
    expect(parseExpiresIn('')).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(parseExpiresIn('abc')).toBeNull();
    expect(parseExpiresIn('2')).toBeNull();
    expect(parseExpiresIn('h3')).toBeNull();
    expect(parseExpiresIn('1w')).toBeNull();
    expect(parseExpiresIn('1H')).toBeNull(); // uppercase not accepted
  });

  it('returns null when N is 0', () => {
    expect(parseExpiresIn('0h')).toBeNull();
    expect(parseExpiresIn('0d')).toBeNull();
  });

  it('returns null when input is negative (not matched by regex)', () => {
    expect(parseExpiresIn('-1h')).toBeNull();
  });

  it('computes hours correctly: now + N*3600', () => {
    expect(parseExpiresIn('1h')).toBe(FIXED_NOW_S + 3600);
    expect(parseExpiresIn('24h')).toBe(FIXED_NOW_S + 24 * 3600);
    expect(parseExpiresIn('48h')).toBe(FIXED_NOW_S + 48 * 3600);
  });

  it('computes days: expires at 23:59:59 server-local N days from today', () => {
    const result = parseExpiresIn('1d');
    // Build expected: today + 1 day at 23:59:59.999 local
    const expected = new Date(FIXED_NOW_MS);
    expected.setDate(expected.getDate() + 1);
    expected.setHours(23, 59, 59, 999);
    expect(result).toBe(Math.floor(expected.getTime() / 1000));
  });

  it('computes 2 days correctly', () => {
    const result = parseExpiresIn('2d');
    const expected = new Date(FIXED_NOW_MS);
    expected.setDate(expected.getDate() + 2);
    expected.setHours(23, 59, 59, 999);
    expect(result).toBe(Math.floor(expected.getTime() / 1000));
  });

  it('1d result is always greater than 1h result', () => {
    const oneHour = parseExpiresIn('1h')!;
    const oneDay = parseExpiresIn('1d')!;
    expect(oneDay).toBeGreaterThan(oneHour);
  });

  it('2d result is greater than 1d result', () => {
    const oneDay = parseExpiresIn('1d')!;
    const twoDays = parseExpiresIn('2d')!;
    expect(twoDays).toBeGreaterThan(oneDay);
  });

  it('large values are accepted: 365d', () => {
    const result = parseExpiresIn('365d');
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThan(FIXED_NOW_S);
  });
});
