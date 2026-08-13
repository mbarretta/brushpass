/**
 * Unit tests for src/lib/throttle.ts.
 *
 * Covers:
 *  - ac4: getClientIp reads the RIGHT-hand end of x-forwarded-for, honors
 *    TRUSTED_PROXY_HOPS (default 0), and cannot be reset by rotating the
 *    attacker-controlled left-hand entries.
 *  - ac7: the sliding-window limiter and getRateLimitCategory, including the
 *    method-aware POST /login category and the anonymous-bcrypt group routes.
 *  - The failed-login lockout primitives the credentials path is built on.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  clearFailures,
  getClientIp,
  getRateLimitCategory,
  isLockedOut,
  isRateLimited,
  loginIpKey,
  loginUserKey,
  recordFailure,
  DEFAULT_TRUSTED_PROXY_HOPS,
  UNKNOWN_IP,
  _resetThrottleState,
  type HeaderSource,
} from '@/lib/throttle';

/** Minimal HeaderSource over a plain header map, case-insensitively. */
function headers(map: Record<string, string>): HeaderSource {
  return {
    headers: {
      get(name: string): string | null {
        const key = Object.keys(map).find((k) => k.toLowerCase() === name.toLowerCase());
        return key ? map[key] : null;
      },
    },
  };
}

beforeEach(() => {
  _resetThrottleState();
  delete process.env.TRUSTED_PROXY_HOPS;
});

afterEach(() => {
  delete process.env.TRUSTED_PROXY_HOPS;
  vi.restoreAllMocks();
});

describe('getClientIp()', () => {
  it('trusts the last hop by default (no self-operated proxies in this deployment)', () => {
    expect(DEFAULT_TRUSTED_PROXY_HOPS).toBe(0);
  });

  it('takes the RIGHT-most x-forwarded-for entry, not the left-most', () => {
    // The left entry is whatever the caller sent; the right one is appended by
    // the infrastructure. Reading the left let anyone spoof their identity.
    expect(getClientIp(headers({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9' }))).toBe('9.9.9.9');
  });

  it('returns the single entry when there is only one', () => {
    expect(getClientIp(headers({ 'x-forwarded-for': '9.9.9.9' }))).toBe('9.9.9.9');
  });

  it('tolerates whitespace and empty entries', () => {
    expect(getClientIp(headers({ 'x-forwarded-for': ' 1.2.3.4 , , 9.9.9.9 ,' }))).toBe('9.9.9.9');
  });

  it('walks left by exactly TRUSTED_PROXY_HOPS when we run our own proxies', () => {
    process.env.TRUSTED_PROXY_HOPS = '1';
    expect(getClientIp(headers({ 'x-forwarded-for': '1.2.3.4, 8.8.8.8, 9.9.9.9' }))).toBe('8.8.8.8');
  });

  it('never walks past the start of the list, however large the hop count', () => {
    process.env.TRUSTED_PROXY_HOPS = '10';
    expect(getClientIp(headers({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9' }))).toBe('1.2.3.4');
  });

  it('ignores a non-numeric or negative TRUSTED_PROXY_HOPS and falls back to the default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.TRUSTED_PROXY_HOPS = 'two';
    expect(getClientIp(headers({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9' }))).toBe('9.9.9.9');

    process.env.TRUSTED_PROXY_HOPS = '-1';
    expect(getClientIp(headers({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9' }))).toBe('9.9.9.9');
    // Latched: the operator is told once, not on every request (see the
    // dedicated case below, which relies on _resetThrottleState clearing it).
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('falls back to x-real-ip, then to UNKNOWN_IP', () => {
    expect(getClientIp(headers({ 'x-real-ip': '7.7.7.7' }))).toBe('7.7.7.7');
    expect(getClientIp(headers({ 'x-forwarded-for': '  ', 'x-real-ip': '7.7.7.7' }))).toBe('7.7.7.7');
    expect(getClientIp(headers({}))).toBe(UNKNOWN_IP);
  });

  it('warns exactly once about a malformed TRUSTED_PROXY_HOPS, not once per request', () => {
    // A typo in the env var must not fill the log at request rate.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.TRUSTED_PROXY_HOPS = 'nonsense';
    for (let i = 0; i < 5; i++) {
      expect(getClientIp(headers({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9' }))).toBe('9.9.9.9');
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('cannot be used to reset a counter by rotating the left-hand entry', () => {
    // The whole point of ac4: an attacker prepending a fresh fake IP on every
    // request must still be counted as one client.
    let limited = false;
    for (let i = 0; i < 11; i++) {
      const ip = getClientIp(headers({ 'x-forwarded-for': `10.9.${i}.${i}, 9.9.9.9` }));
      expect(ip).toBe('9.9.9.9');
      limited = isRateLimited('login', ip);
    }
    expect(limited).toBe(true);
  });
});

describe('getRateLimitCategory()', () => {
  it('keeps the pre-existing path categories unchanged', () => {
    expect(getRateLimitCategory('/api/auth/callback/credentials')).toBe('login');
    expect(getRateLimitCategory('/api/download/abc')).toBe('download');
    expect(getRateLimitCategory('/api/account')).toBe('account');
    expect(getRateLimitCategory('/api/cleanup')).toBe('cleanup');
    expect(getRateLimitCategory('/api/agent/device/start')).toBe('device_start');
    expect(getRateLimitCategory('/api/agent/device/token')).toBe('device_token');
  });

  it('categorizes POST /login as login but leaves the GET page uncapped', () => {
    // The login form is a server action posting to the page itself, so this is
    // the transport a browser login actually uses.
    expect(getRateLimitCategory('/login', 'POST')).toBe('login');
    expect(getRateLimitCategory('/login', 'post')).toBe('login');
    expect(getRateLimitCategory('/login', 'GET')).toBeNull();
    expect(getRateLimitCategory('/login')).toBeNull();
  });

  it('categorizes the anonymous group access POST, which costs one bcrypt compare', () => {
    expect(getRateLimitCategory('/api/groups/my-group/access', 'POST')).toBe('group_access');
    expect(getRateLimitCategory('/api/groups/my-group/access', 'GET')).toBeNull();
    expect(getRateLimitCategory('/api/groups/my-group/access/extra', 'POST')).toBeNull();
  });

  it('categorizes the anonymous group file download, which also costs one compare', () => {
    expect(getRateLimitCategory(`/api/groups/my-group/files/${'a'.repeat(64)}`, 'GET')).toBe(
      'group_download',
    );
    expect(getRateLimitCategory('/api/groups/my-group/files', 'GET')).toBeNull();
  });

  it('returns null for uncategorized paths', () => {
    expect(getRateLimitCategory('/api/upload', 'POST')).toBeNull();
    expect(getRateLimitCategory('/', 'GET')).toBeNull();
    expect(getRateLimitCategory('/api/agent/device', 'POST')).toBeNull();
  });
});

describe('isRateLimited()', () => {
  it('caps a category per IP and tracks other IPs independently', () => {
    let limited = false;
    for (let i = 0; i < 11; i++) {
      limited = isRateLimited('group_access', '10.1.0.1');
    }
    expect(limited).toBe(true);
    expect(isRateLimited('group_access', '10.1.0.2')).toBe(false);
  });

  it('opens a fresh window once the previous one has elapsed', () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 11; i++) isRateLimited('group_access', '10.1.0.3');
      expect(isRateLimited('group_access', '10.1.0.3')).toBe(true);

      vi.advanceTimersByTime(61_000);
      expect(isRateLimited('group_access', '10.1.0.3')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never limits an unknown category', () => {
    for (let i = 0; i < 100; i++) {
      expect(isRateLimited('not-a-category', '10.1.0.4')).toBe(false);
    }
  });
});

describe('failed-login lockout', () => {
  it('locks a username after 5 failures and clears on success', () => {
    const key = loginUserKey('alice');
    for (let i = 0; i < 4; i++) recordFailure(key);
    expect(isLockedOut(key)).toBe(false);

    recordFailure(key);
    expect(isLockedOut(key)).toBe(true);

    clearFailures(key);
    expect(isLockedOut(key)).toBe(false);
  });

  it('keys usernames case-insensitively so casing variants share one counter', () => {
    for (let i = 0; i < 5; i++) recordFailure(loginUserKey('Alice'));
    expect(isLockedOut(loginUserKey('alice'))).toBe(true);
    expect(isLockedOut(loginUserKey('ALICE'))).toBe(true);
  });

  it('gives the IP dimension a looser budget than the username dimension', () => {
    const ipKey = loginIpKey('9.9.9.9');
    expect(ipKey).not.toBeNull();
    for (let i = 0; i < 19; i++) recordFailure(ipKey!);
    expect(isLockedOut(ipKey!)).toBe(false);
    recordFailure(ipKey!);
    expect(isLockedOut(ipKey!)).toBe(true);
  });

  it('has no IP key at all for an unresolvable client IP', () => {
    // Otherwise every caller behind a header-stripping proxy — and every request
    // in local dev — would share one counter and lock each other out.
    expect(loginIpKey(UNKNOWN_IP)).toBeNull();
    expect(loginIpKey(getClientIp(headers({})))).toBeNull();
  });

  it('expires a lockout after its window and ignores unknown key prefixes', () => {
    vi.useFakeTimers();
    try {
      const key = loginUserKey('bob');
      for (let i = 0; i < 5; i++) recordFailure(key);
      expect(isLockedOut(key)).toBe(true);

      vi.advanceTimersByTime(15 * 60_000 + 1_000);
      expect(isLockedOut(key)).toBe(false);
    } finally {
      vi.useRealTimers();
    }

    recordFailure('not_a_dimension:x');
    expect(isLockedOut('not_a_dimension:x')).toBe(false);
  });
});
