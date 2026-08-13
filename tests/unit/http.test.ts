/**
 * Unit tests for the shared HTTP request helpers in src/lib/http.ts.
 *
 * These three primitives replace per-route hand-rolled versions, so the tests
 * pin the exact behaviors the route handlers now depend on:
 *   - parseId rejects anything that is not a run of decimal digits, which is
 *     what stops `/api/admin/users/1.png` from being coerced to id 1 by
 *     parseInt's prefix parsing.
 *   - extractBearerToken is the single Bearer parser; the three call sites it
 *     replaced disagreed with each other about case, spacing, and the
 *     "Bearer"-less header.
 *   - readJson turns the six-line try/catch idiom into one call and always
 *     produces the same 400 body.
 */
import { describe, it, expect } from 'vitest';
import { parseId, extractBearerToken, readJson } from '@/lib/http';

/** Minimal HeaderSource over a plain header map, case-insensitively. */
function headers(map: Record<string, string>): { headers: { get(n: string): string | null } } {
  return {
    headers: {
      get(name: string): string | null {
        const key = Object.keys(map).find((k) => k.toLowerCase() === name.toLowerCase());
        return key === undefined ? null : map[key];
      },
    },
  };
}

describe('parseId()', () => {
  it('accepts a plain run of digits', () => {
    expect(parseId('1')).toBe(1);
    expect(parseId('42')).toBe(42);
    expect(parseId('0')).toBe(0);
  });

  it('rejects a fake extension instead of coercing it (the parseInt bug)', () => {
    // parseInt('1.png', 10) === 1. That is how a request to
    // /api/admin/users/1.png reached user 1 while skipping the proxy's
    // extension-excluded matcher — two independent bugs lining up.
    expect(parseId('1.png')).toBeNull();
    expect(parseId('1.jpg')).toBeNull();
    expect(parseId('12abc')).toBeNull();
    expect(parseId('1 ')).toBeNull();
    expect(parseId(' 1')).toBeNull();
  });

  it('rejects non-numeric, signed, fractional and exponent forms', () => {
    expect(parseId('')).toBeNull();
    expect(parseId('abc')).toBeNull();
    expect(parseId('-1')).toBeNull();
    expect(parseId('+1')).toBeNull();
    expect(parseId('1.5')).toBeNull();
    expect(parseId('1e3')).toBeNull();
    expect(parseId('0x1')).toBeNull();
    expect(parseId('NaN')).toBeNull();
    expect(parseId('Infinity')).toBeNull();
  });

  it('rejects a digit run too large to be an exact integer', () => {
    // Passes /^\d+$/ but Number() would silently round it, so two distinct
    // URLs could map to the same id.
    expect(parseId('99999999999999999999')).toBeNull();
  });

  it('accepts leading zeros, which are exact and address the same row', () => {
    expect(parseId('007')).toBe(7);
  });
});

describe('extractBearerToken()', () => {
  it('extracts the token from a well-formed header', () => {
    expect(extractBearerToken(headers({ authorization: 'Bearer abc.def' }))).toBe('abc.def');
  });

  it('treats the scheme case-insensitively, per RFC 7235', () => {
    // The three parsers this replaced all did a case-SENSITIVE
    // startsWith('Bearer ') / replace('Bearer ', ''), so `bearer x` silently
    // fell through to a different auth path on each route.
    expect(extractBearerToken(headers({ authorization: 'bearer abc' }))).toBe('abc');
    expect(extractBearerToken(headers({ authorization: 'BEARER abc' }))).toBe('abc');
  });

  it('tolerates surrounding and repeated whitespace', () => {
    expect(extractBearerToken(headers({ authorization: '  Bearer   abc  ' }))).toBe('abc');
  });

  it('reads the capitalized header name too', () => {
    expect(extractBearerToken(headers({ Authorization: 'Bearer abc' }))).toBe('abc');
  });

  it('returns null for a missing, empty, or non-Bearer header', () => {
    expect(extractBearerToken(headers({}))).toBeNull();
    expect(extractBearerToken(headers({ authorization: '' }))).toBeNull();
    expect(extractBearerToken(headers({ authorization: 'Basic abc' }))).toBeNull();
    expect(extractBearerToken(headers({ authorization: 'Bearer' }))).toBeNull();
    expect(extractBearerToken(headers({ authorization: 'Bearer   ' }))).toBeNull();
  });

  it('does not treat a bare token as a Bearer credential', () => {
    // The old `.replace('Bearer ', '')` returned the whole header when the
    // prefix was absent, so `Authorization: <token>` was accepted as a token.
    expect(extractBearerToken(headers({ authorization: 'abc.def' }))).toBeNull();
  });
});

describe('readJson()', () => {
  it('returns the parsed body on valid JSON', async () => {
    const result = await readJson(new Request('http://localhost/x', {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
    }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toEqual({ a: 1 });
  });

  it('returns a 400 response with the shared body on malformed JSON', async () => {
    const result = await readJson(new Request('http://localhost/x', {
      method: 'POST',
      body: '{not json',
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect(await result.response.json()).toEqual({
        error: 'Invalid JSON body',
        phase: 'body-parse',
      });
    }
  });

  it('reports the malformed-body 400 for an empty body too', async () => {
    // A POST with no body at all: request.json() rejects, which is the case the
    // download route relies on to distinguish "no JSON" from "JSON with no token".
    const result = await readJson(new Request('http://localhost/x', { method: 'POST' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });
});
