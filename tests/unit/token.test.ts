import { describe, it, expect } from 'vitest';
import { generateToken, hashToken, verifyToken } from '@/lib/token';

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
