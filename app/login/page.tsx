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
  const hasError = params.error === 'CredentialsSignin';
  const oidcEnabled = Boolean(process.env.AUTH_OIDC_ISSUER);

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-lg shadow-md p-8">
        <h1 className="text-2xl font-semibold text-gray-900 mb-6 text-center">Sign in</h1>

        {hasError && (
          <div
            role="alert"
            className="mb-4 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            Invalid username or password.
          </div>
        )}

        <form action={credentialsSignIn} className="space-y-4">
          {/* Pass callbackUrl through so the server action can redirect correctly */}
          <input type="hidden" name="callbackUrl" value={callbackUrl} />

          <div>
            <label htmlFor="username" className="block text-sm font-medium text-gray-700 mb-1">
              Username
            </label>
            <input
              id="username"
              name="username"
              type="text"
              required
              autoComplete="username"
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <button
            type="submit"
            className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          >
            Sign in
          </button>
        </form>

        {oidcEnabled && (
          <div className="mt-4">
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-200" />
              </div>
              <div className="relative flex justify-center text-xs text-gray-500">
                <span className="bg-white px-2">or</span>
              </div>
            </div>
            <form action={oidcSignIn} className="mt-4">
              <button
                type="submit"
                className="w-full rounded border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
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
