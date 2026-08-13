import crypto from 'crypto';
import bcrypt from 'bcryptjs';

export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export async function hashToken(token: string): Promise<string> {
  return bcrypt.hash(token, 10);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyToken(token: string, hash: string): Promise<boolean> {
  return bcrypt.compare(token, hash);
}

export const verifyPassword = verifyToken;

export type ValidationResult = { ok: true } | { ok: false; error: string };

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

/**
 * Shared password-strength rule, applied identically wherever a password is
 * accepted: admin create, admin reset, and self-service change. Centralizing
 * this closes the gap where the admin routes silently accepted a
 * single-character password while the self-service route enforced a
 * (weaker) minimum of its own.
 */
export function validatePassword(password: string): ValidationResult {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters` };
  }
  return { ok: true };
}

const MIN_USERNAME_LENGTH = 1;
const MAX_USERNAME_LENGTH = 64;
const USERNAME_PATTERN = /^[A-Za-z0-9._@-]+$/;

/**
 * Bounds the username an admin can assign on create or rename. No endpoint
 * in this codebase currently accepts an email field as user-supplied input
 * (OIDC users get their email from the verified IdP claim, never a request
 * body) so there is no corresponding validateEmail call site here.
 */
export function validateUsername(username: string): ValidationResult {
  if (username.length < MIN_USERNAME_LENGTH || username.length > MAX_USERNAME_LENGTH) {
    return {
      ok: false,
      error: `Username must be between ${MIN_USERNAME_LENGTH} and ${MAX_USERNAME_LENGTH} characters`,
    };
  }
  if (!USERNAME_PATTERN.test(username)) {
    return { ok: false, error: 'Username may only contain letters, numbers, and . _ - @' };
  }
  return { ok: true };
}
