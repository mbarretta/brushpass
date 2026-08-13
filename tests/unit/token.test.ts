import { describe, it, expect } from 'vitest';
import {
  generateToken,
  hashToken,
  verifyToken,
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
