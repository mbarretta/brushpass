import { describe, it, expect, afterEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import {
  generateToken,
  hashToken,
  verifyToken,
  verifySecret,
  validatePassword,
  validateUsername,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
} from '@/lib/token';

describe('generateToken()', () => {
  it('returns a 64-character hex string', () => {
    const token = generateToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates unique tokens on each call', () => {
    const t1 = generateToken();
    const t2 = generateToken();
    expect(t1).not.toBe(t2);
  });
});

describe('hashToken()', () => {
  it('returns a bcrypt hash string', async () => {
    const token = generateToken();
    const hash = await hashToken(token);
    // bcrypt hashes start with $2b$ or $2a$
    expect(hash).toMatch(/^\$2[ab]\$\d+\$/);
  });

  it('hash differs from original token', async () => {
    const token = generateToken();
    const hash = await hashToken(token);
    expect(hash).not.toBe(token);
  });
});

describe('verifyToken()', () => {
  it('returns true for matching token and hash', async () => {
    const token = generateToken();
    const hash = await hashToken(token);
    const result = await verifyToken(token, hash);
    expect(result).toBe(true);
  });

  it('returns false for non-matching token', async () => {
    const token = generateToken();
    const hash = await hashToken(token);
    const wrongToken = generateToken();
    const result = await verifyToken(wrongToken, hash);
    expect(result).toBe(false);
  });

  it('returns false for empty string token against real hash', async () => {
    const token = generateToken();
    const hash = await hashToken(token);
    const result = await verifyToken('', hash);
    expect(result).toBe(false);
  });
});

describe('validatePassword()', () => {
  it('rejects a password shorter than the minimum (closes the 1-char admin gap)', () => {
    const result = validatePassword('a');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(new RegExp(`${MIN_PASSWORD_LENGTH} characters`));
  });

  it(`rejects a password exactly one character below the ${MIN_PASSWORD_LENGTH}-char minimum`, () => {
    const result = validatePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1));
    expect(result.ok).toBe(false);
  });

  it(`accepts a password exactly at the ${MIN_PASSWORD_LENGTH}-char minimum`, () => {
    const result = validatePassword('a'.repeat(MIN_PASSWORD_LENGTH));
    expect(result.ok).toBe(true);
  });

  it(`accepts a password exactly at the ${MAX_PASSWORD_LENGTH}-char maximum`, () => {
    const result = validatePassword('a'.repeat(MAX_PASSWORD_LENGTH));
    expect(result.ok).toBe(true);
  });

  it(`rejects a password one character over the ${MAX_PASSWORD_LENGTH}-char maximum`, () => {
    const result = validatePassword('a'.repeat(MAX_PASSWORD_LENGTH + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(new RegExp(`${MAX_PASSWORD_LENGTH} characters`));
  });
});

describe('validateUsername()', () => {
  it('accepts a normal username', () => {
    expect(validateUsername('alice')).toEqual({ ok: true });
  });

  it('accepts an email-shaped username (OIDC-style)', () => {
    expect(validateUsername('alice@example.com').ok).toBe(true);
  });

  it('rejects an empty username', () => {
    const result = validateUsername('');
    expect(result.ok).toBe(false);
  });

  it('rejects a username over 64 characters', () => {
    const result = validateUsername('a'.repeat(65));
    expect(result.ok).toBe(false);
  });

  it('rejects a username containing control characters', () => {
    const result = validateUsername('alice\r\nX-Injected: 1');
    expect(result.ok).toBe(false);
  });

  it('rejects a username containing whitespace', () => {
    const result = validateUsername('alice smith');
    expect(result.ok).toBe(false);
  });
});

describe('verifySecret()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true for the matching secret and its stored hash', async () => {
    const secret = generateToken();
    const hash = await hashToken(secret);
    expect(await verifySecret(secret, hash)).toBe(true);
  });

  it('returns false for a wrong secret against a real hash', async () => {
    const hash = await hashToken(generateToken());
    expect(await verifySecret('not-the-secret', hash)).toBe(false);
  });

  it('returns false — and still spends exactly one bcrypt compare — when the hash is absent', async () => {
    // The point of the helper: a missing record must not be a fast path, or the
    // call site becomes an existence oracle for usernames and group slugs.
    const compare = vi.spyOn(bcrypt, 'compare');

    expect(await verifySecret('anything', null)).toBe(false);
    expect(await verifySecret('anything', undefined)).toBe(false);
    expect(await verifySecret('anything', '')).toBe(false);

    expect(compare).toHaveBeenCalledTimes(3);
    // Every absent-record call compared against the same fixed, valid-format
    // bcrypt hash rather than skipping the work.
    const hashArgs = compare.mock.calls.map((call) => call[1]);
    expect(new Set(hashArgs).size).toBe(1);
    expect(hashArgs[0]).toMatch(/^\$2[aby]\$10\$/);
  });

  it('spends exactly one compare on the present-hash path too', async () => {
    const hash = await hashToken(generateToken());
    const compare = vi.spyOn(bcrypt, 'compare');

    await verifySecret('wrong', hash);

    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare.mock.calls[0][1]).toBe(hash);
  });
});
