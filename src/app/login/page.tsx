import type { Metadata } from 'next';
import { credentialsSignIn, oidcSignIn } from './actions';

export const metadata: Metadata = {
  title: 'Sign in',
};

interface LoginPageProps {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const callbackUrl = params.callbackUrl ?? '/';
  // AccessDenied is next-auth's code for a signIn-callback refusal — here,
  // the OIDC gate rejecting a profile without a verified email / resolvable
  // domain. Anything else unexpected still gets a generic banner rather than
  // a silent bounce back to the form.
  const errorMessage =
    params.error === 'CredentialsSignin'
      ? 'Invalid username or password.'
      : params.error === 'AccessDenied'
        ? 'Sign-in was refused: your identity provider did not supply a verified email for this account. Contact an administrator.'
        : params.error
          ? 'Sign-in failed. Please try again or contact an administrator.'
          : null;
  const oidcEnabled = Boolean(process.env.AUTH_OIDC_ISSUER);

  return (
    <main className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950 px-4">
      <div className="w-full max-w-sm bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-8">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mb-6 text-center">Sign in</h1>

        {errorMessage && (
          <div
            role="alert"
            className="mb-4 rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950 px-4 py-3 text-sm text-red-700 dark:text-red-400"
          >
            {errorMessage}
          </div>
        )}

        <form action={credentialsSignIn} className="space-y-4">
          {/* Pass callbackUrl through so the server action can redirect correctly */}
          <input type="hidden" name="callbackUrl" value={callbackUrl} />

          <div>
            <label htmlFor="username" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Username
            </label>
            <input
              id="username"
              name="username"
              type="text"
              required
              autoComplete="username"
              className="w-full rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="w-full rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <button
            type="submit"
            className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-zinc-900"
          >
            Sign in
          </button>
        </form>

        {oidcEnabled && (
          <div className="mt-4">
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-zinc-200 dark:border-zinc-700" />
              </div>
              <div className="relative flex justify-center text-xs text-zinc-500">
                <span className="bg-white dark:bg-zinc-900 px-2">or</span>
              </div>
            </div>
            <form action={oidcSignIn} className="mt-4">
              <button
                type="submit"
                className="w-full rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-zinc-900"
              >
                Sign in with SSO
              </button>
            </form>
          </div>
        )}
      </div>
    </main>
  );
}
