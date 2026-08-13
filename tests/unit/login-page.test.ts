/**
 * Renders the /login server component directly (same element-tree inspection
 * idiom as group-page-leak.test.ts) and asserts the error banner mapping:
 * CredentialsSignin and AccessDenied get distinct, specific messages, any
 * other error code gets a generic banner instead of a silent bounce, and no
 * error means no banner at all.
 */
import { describe, it, expect, vi } from 'vitest';

// The page imports server actions; stub them so importing the component
// doesn't drag next-auth's request-scoped machinery into the test env.
vi.mock('@/app/login/actions', () => ({
  credentialsSignIn: vi.fn(),
  oidcSignIn: vi.fn(),
}));

// Capture the config passed to NextAuth so the routing premise is pinned:
// the banner below is reachable only if pages.error routes auth errors
// (AccessDenied has kind 'error', not 'signIn') to /login instead of
// next-auth's built-in /api/auth/error page.
const captured = vi.hoisted(() => ({ config: undefined as Record<string, unknown> | undefined }));
vi.mock('next-auth', () => ({
  default: (config: Record<string, unknown>) => {
    captured.config = config;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
}));

import LoginPage from '@/app/login/page';

async function renderLogin(error?: string): Promise<string> {
  const element = await LoginPage({
    searchParams: Promise.resolve(error ? { error } : {}),
  });
  return JSON.stringify(element);
}

describe('/login error banner', () => {
  it('shows the credentials message for error=CredentialsSignin', async () => {
    const tree = await renderLogin('CredentialsSignin');
    expect(tree).toContain('Invalid username or password.');
  });

  it('shows a distinct refusal message for error=AccessDenied (OIDC signIn-callback rejection)', async () => {
    const tree = await renderLogin('AccessDenied');
    expect(tree).toContain('Sign-in was refused');
    expect(tree).toContain('verified email');
    expect(tree).not.toContain('Invalid username or password.');
  });

  it('shows a generic banner for an unrecognized error code rather than nothing', async () => {
    const tree = await renderLogin('Configuration');
    expect(tree).toContain('Sign-in failed. Please try again');
    // The raw error code is never echoed back into the page.
    expect(tree).not.toContain('Configuration');
  });

  it('renders no alert at all when there is no error param', async () => {
    const tree = await renderLogin();
    expect(tree).not.toContain('"role":"alert"');
  });
});

describe('auth config error routing', () => {
  it('routes auth errors to /login so the AccessDenied banner is actually reachable', async () => {
    await import('@/auth');
    const pages = captured.config?.pages as { signIn?: string; error?: string } | undefined;
    expect(pages?.signIn).toBe('/login');
    expect(pages?.error).toBe('/login');
  });
});
