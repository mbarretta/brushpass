/**
 * Route-handler unit tests for /api/download/[sha256] (GET and POST).
 *
 * Two properties dominate this file:
 *
 *  - The route hands back a short-lived signed GCS URL rather than streaming
 *    bytes (which would hit Cloud Run's 32MB response cap). GET redirects to
 *    it for links already in circulation; POST returns it as `{ url }` so the
 *    browser never puts the capability token in a URL.
 *  - Nothing about a file is observable without a valid token. An unknown
 *    digest, an expired file and a wrong token all produce the SAME 401, and
 *    the 410 expiry answer is reachable only after the token verifies. The
 *    checks therefore run in the order token -> verify -> existence -> expiry,
 *    which is the reverse of what reads naturally, so the ordering tests below
 *    exist to keep it that way.
 *
 * Kept in a separate file from download.test.ts so that vi.mock hoisting
 * here does not interfere with the real-DB tests in that file.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — hoisted by Vitest before any imports
// ---------------------------------------------------------------------------

vi.mock('@/lib/token', () => ({
  verifySecret: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/gcs', () => ({
  generateSignedDownloadUrl: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getFileBySha256ForAuth: vi.fn(),
  logDownload: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A valid 64-char hex sha256 value for tests
const VALID_SHA256 = 'd8e8fca2dc0f896fd7cb4cb0031ba249d8e8fca2dc0f896fd7cb4cb0031ba249';
const SIGNED_URL = 'https://storage.googleapis.com/signed';

function makeRecord(original_name: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    filename: `${VALID_SHA256}.pdf`,
    original_name,
    sha256: VALID_SHA256,
    size: 4,
    content_type: 'application/pdf',
    gcs_key: `${VALID_SHA256}.pdf`,
    token_hash: '$2b$10$fakehash',
    expires_at: null,
    uploaded_by: null,
    created_at: Math.floor(Date.now() / 1000),
    uploaded_at: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

const params = { params: Promise.resolve({ sha256: VALID_SHA256 }) };

async function db() {
  return vi.mocked(await import('@/lib/db'));
}
async function token() {
  return vi.mocked(await import('@/lib/token'));
}

/** Resets the mocks to the "everything is fine" baseline before each case. */
async function resetMocks() {
  vi.resetAllMocks();
  (await token()).verifySecret.mockResolvedValue(true);
  vi.mocked((await import('@/lib/gcs')).generateSignedDownloadUrl).mockResolvedValue(SIGNED_URL);
}

function getRequest(query = ''): Request {
  return new Request(`http://localhost/api/download/${VALID_SHA256}${query}`);
}

function postRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/download/${VALID_SHA256}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/download/[sha256] route handler — hex guard', () => {
  beforeEach(resetMocks);

  it('returns 404 with validation phase for a non-hex sha256', async () => {
    const { GET } = await import('@/app/api/download/[sha256]/route');
    const req = new Request('http://localhost/api/download/notahash?token=valid');
    const res = await GET(req as never, { params: Promise.resolve({ sha256: 'notahash' }) });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found', phase: 'validation' });
    expect((await db()).getFileBySha256ForAuth).not.toHaveBeenCalled();
  });

  it('returns 404 for a 63-char hex string (wrong length)', async () => {
    const shortHex = 'a'.repeat(63);
    const { GET } = await import('@/app/api/download/[sha256]/route');
    const req = new Request(`http://localhost/api/download/${shortHex}?token=valid`);
    const res = await GET(req as never, { params: Promise.resolve({ sha256: shortHex }) });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found', phase: 'validation' });
    expect((await db()).getFileBySha256ForAuth).not.toHaveBeenCalled();
  });
});

describe('GET /api/download/[sha256] route handler — signed redirect', () => {
  beforeEach(resetMocks);

  it('returns 302 redirect to signed GCS URL for an already-shared ?token= link', async () => {
    (await db()).getFileBySha256ForAuth.mockReturnValue(makeRecord('report.pdf'));

    const { GET } = await import('@/app/api/download/[sha256]/route');
    const res = await GET(getRequest('?token=valid') as never, params);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(SIGNED_URL);
  });

  it('accepts an Authorization: Bearer token as well as the query param', async () => {
    (await db()).getFileBySha256ForAuth.mockReturnValue(makeRecord('report.pdf'));

    const { GET } = await import('@/app/api/download/[sha256]/route');
    const req = new Request(`http://localhost/api/download/${VALID_SHA256}`, {
      headers: { authorization: 'Bearer valid' },
    });
    const res = await GET(req as never, params);

    expect(res.status).toBe(302);
    expect((await token()).verifySecret).toHaveBeenCalledWith('valid', '$2b$10$fakehash');
  });

  it('passes correct originalName and contentType to generateSignedDownloadUrl', async () => {
    (await db()).getFileBySha256ForAuth.mockReturnValue(makeRecord('my report 2026.pdf'));

    const { GET } = await import('@/app/api/download/[sha256]/route');
    await GET(getRequest('?token=valid') as never, params);

    const gcs = await import('@/lib/gcs');
    expect(vi.mocked(gcs.generateSignedDownloadUrl)).toHaveBeenCalledWith(
      `${VALID_SHA256}.pdf`,
      'my report 2026.pdf',
      'application/pdf',
    );
  });
});

describe('POST /api/download/[sha256] — tokenless browser flow', () => {
  beforeEach(resetMocks);

  it('takes the token from the request BODY and returns { url }', async () => {
    (await db()).getFileBySha256ForAuth.mockReturnValue(makeRecord('report.pdf'));

    const { POST } = await import('@/app/api/download/[sha256]/route');
    const res = await POST(postRequest({ token: 'secret-token' }) as never, params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: SIGNED_URL });
    expect((await token()).verifySecret).toHaveBeenCalledWith('secret-token', '$2b$10$fakehash');
  });

  it('authorizes from the body alone, so the request line can stay credential-free', async () => {
    (await db()).getFileBySha256ForAuth.mockReturnValue(makeRecord('report.pdf'));

    // The point of the POST path: the token reaches the handler with nothing in
    // the URL for a proxy or Cloud Logging to record. Reverting the handler to
    // read `?token=` would fail this, because there is no query string to read.
    const req = postRequest({ token: 'secret-token' });
    const { POST } = await import('@/app/api/download/[sha256]/route');
    const res = await POST(req as never, params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: SIGNED_URL });
    expect((await token()).verifySecret).toHaveBeenCalledWith('secret-token', '$2b$10$fakehash');
  });

  it('ignores a query-string token on POST, so the tokenless path cannot silently regress', async () => {
    (await db()).getFileBySha256ForAuth.mockReturnValue(makeRecord('report.pdf'));

    const req = new Request(`http://localhost/api/download/${VALID_SHA256}?token=from-the-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { POST } = await import('@/app/api/download/[sha256]/route');
    const res = await POST(req as never, params);

    // No body token and no Bearer header: the URL token must not rescue it.
    expect(res.status).toBe(401);
    expect((await token()).verifySecret).not.toHaveBeenCalled();
  });

  it('accepts an Authorization: Bearer token with no body at all', async () => {
    (await db()).getFileBySha256ForAuth.mockReturnValue(makeRecord('report.pdf'));

    const { POST } = await import('@/app/api/download/[sha256]/route');
    const req = new Request(`http://localhost/api/download/${VALID_SHA256}`, {
      method: 'POST',
      headers: { authorization: 'Bearer api-token' },
    });
    const res = await POST(req as never, params);

    expect(res.status).toBe(200);
    expect((await token()).verifySecret).toHaveBeenCalledWith('api-token', '$2b$10$fakehash');
  });

  it('returns 400 for a malformed JSON body', async () => {
    const { POST } = await import('@/app/api/download/[sha256]/route');
    const req = new Request(`http://localhost/api/download/${VALID_SHA256}`, {
      method: 'POST',
      body: '{not json',
    });
    const res = await POST(req as never, params);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON body', phase: 'body-parse' });
  });

  it('returns the constant 401 for a body carrying no token', async () => {
    const { POST } = await import('@/app/api/download/[sha256]/route');
    const res = await POST(postRequest({}) as never, params);

    expect(res.status).toBe(401);
    expect((await db()).getFileBySha256ForAuth).not.toHaveBeenCalled();
  });
});

describe('/api/download/[sha256] — no existence or state oracle', () => {
  beforeEach(resetMocks);

  /** Runs GET and captures exactly what an unauthenticated caller observes. */
  async function observe(query: string, setup: () => Promise<void>) {
    await resetMocks();
    await setup();
    const { GET } = await import('@/app/api/download/[sha256]/route');
    const res = await GET(getRequest(query) as never, params);
    return { status: res.status, body: await res.text() };
  }

  it('answers an unknown digest, an expired file and a wrong token identically', async () => {
    const unknown = await observe('?token=whatever', async () => {
      (await db()).getFileBySha256ForAuth.mockReturnValue(undefined);
      (await token()).verifySecret.mockResolvedValue(false);
    });

    const expired = await observe('?token=whatever', async () => {
      (await db()).getFileBySha256ForAuth.mockReturnValue(
        makeRecord('report.pdf', { expires_at: Math.floor(Date.now() / 1000) - 3600 }),
      );
      (await token()).verifySecret.mockResolvedValue(false);
    });

    const wrongToken = await observe('?token=whatever', async () => {
      (await db()).getFileBySha256ForAuth.mockReturnValue(makeRecord('report.pdf'));
      (await token()).verifySecret.mockResolvedValue(false);
    });

    const missingToken = await observe('', async () => {
      (await db()).getFileBySha256ForAuth.mockReturnValue(makeRecord('report.pdf'));
    });

    expect(unknown.status).toBe(401);
    // Byte-for-byte identical, including the `phase` debug field: a varying
    // phase would rebuild the oracle the status code no longer provides.
    expect(expired).toEqual(unknown);
    expect(wrongToken).toEqual(unknown);
    expect(missingToken).toEqual(unknown);
  });

  it('spends exactly one bcrypt compare whether or not the row exists', async () => {
    await resetMocks();
    (await db()).getFileBySha256ForAuth.mockReturnValue(undefined);
    (await token()).verifySecret.mockResolvedValue(false);

    const { GET } = await import('@/app/api/download/[sha256]/route');
    await GET(getRequest('?token=whatever') as never, params);

    // Compared against the fixed dummy hash (null record), so the unknown-digest
    // path costs the same wall-clock time as the wrong-token path.
    expect((await token()).verifySecret).toHaveBeenCalledTimes(1);
    expect((await token()).verifySecret).toHaveBeenCalledWith('whatever', null);
  });

  it('spends no bcrypt compare and no DB read when there is no token', async () => {
    await resetMocks();

    const { GET } = await import('@/app/api/download/[sha256]/route');
    const res = await GET(getRequest() as never, params);

    expect(res.status).toBe(401);
    expect((await db()).getFileBySha256ForAuth).not.toHaveBeenCalled();
    expect((await token()).verifySecret).not.toHaveBeenCalled();
  });

  it('will not serve a file just because the compare succeeded against a missing row', async () => {
    await resetMocks();
    (await db()).getFileBySha256ForAuth.mockReturnValue(undefined);
    // Defense in depth: even if verifySecret somehow said yes, there is no
    // record to sign, so the answer must still be the constant 401.
    (await token()).verifySecret.mockResolvedValue(true);

    const { GET } = await import('@/app/api/download/[sha256]/route');
    const res = await GET(getRequest('?token=whatever') as never, params);

    expect(res.status).toBe(401);
    expect(vi.mocked((await import('@/lib/gcs')).generateSignedDownloadUrl)).not.toHaveBeenCalled();
  });

  it('reveals the 410 expiry answer only once the token verifies', async () => {
    await resetMocks();
    (await db()).getFileBySha256ForAuth.mockReturnValue(
      makeRecord('report.pdf', { expires_at: Math.floor(Date.now() / 1000) - 3600 }),
    );
    (await token()).verifySecret.mockResolvedValue(true);

    const { GET } = await import('@/app/api/download/[sha256]/route');
    const res = await GET(getRequest('?token=valid') as never, params);

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'File has expired', phase: 'expiry-check' });
    // Expired means expired: no signed URL is minted on this path.
    expect(vi.mocked((await import('@/lib/gcs')).generateSignedDownloadUrl)).not.toHaveBeenCalled();
  });

  it('does not log a download for a request that failed authorization', async () => {
    await resetMocks();
    (await db()).getFileBySha256ForAuth.mockReturnValue(makeRecord('report.pdf'));
    (await token()).verifySecret.mockResolvedValue(false);

    const { GET } = await import('@/app/api/download/[sha256]/route');
    await GET(getRequest('?token=wrong') as never, params);

    expect((await db()).logDownload).not.toHaveBeenCalled();
  });

  it('applies the same ordering to POST', async () => {
    await resetMocks();
    (await db()).getFileBySha256ForAuth.mockReturnValue(undefined);
    (await token()).verifySecret.mockResolvedValue(false);

    const { GET, POST } = await import('@/app/api/download/[sha256]/route');
    const postRes = await POST(postRequest({ token: 'whatever' }) as never, params);
    const getRes = await GET(getRequest('?token=whatever') as never, params);

    expect(postRes.status).toBe(401);
    expect(await postRes.text()).toBe(await getRes.text());
  });
});
