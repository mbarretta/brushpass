import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import type { NextAuthConfig } from 'next-auth';
import type { Permission } from '@/types';

// ── TypeScript module augmentation ──────────────────────────────────────────
// In Auth.js v5 beta, the JWT interface lives in @auth/core/jwt.
// The User/Session interfaces live in next-auth (which re-exports from @auth/core/types).
declare module 'next-auth' {
  interface User {
    id: string;
    username: string;
    permissions: Permission[];
  }
  interface Session {
    user: User;
  }
}

declare module '@auth/core/jwt' {
  interface JWT {
    id: string;
    username: string;
    permissions: Permission[];
  }
}

// ── OIDC provider (optional) ─────────────────────────────────────────────────
const oidcIssuer = process.env.AUTH_OIDC_ISSUER ?? '';
const oidcClientId = process.env.AUTH_OIDC_CLIENT_ID ?? '';
const oidcClientSecret = process.env.AUTH_OIDC_CLIENT_SECRET ?? '';

const oidcVarsSet = [oidcIssuer, oidcClientId, oidcClientSecret].filter(Boolean).length;

if (oidcVarsSet > 0 && oidcVarsSet < 3) {
  console.warn(
    '[auth] Partial OIDC configuration detected. AUTH_OIDC_ISSUER, AUTH_OIDC_CLIENT_ID, and ' +
      'AUTH_OIDC_CLIENT_SECRET must all be set to enable OIDC login. OIDC provider is disabled.',
  );
}

const oidcEnabled = oidcVarsSet === 3;

// Build the OIDC provider config lazily — only when all three vars are present.
// We use a generic OIDC provider via built-in wellKnown discovery.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const oidcProvider: any = oidcEnabled
  ? {
      id: 'oidc',
      name: 'SSO',
      type: 'oidc' as const,
      issuer: oidcIssuer,
      clientId: oidcClientId,
      clientSecret: oidcClientSecret,
    }
  : null;

// ── Auth.js config ────────────────────────────────────────────────────────────
const config: NextAuthConfig = {
  // JWT session strategy — no DB adapter
  session: { strategy: 'jwt' },

  pages: {
    signIn: '/login',
  },

  providers: [
    Credentials({
      name: 'Credentials',
      credentials: {
        username: { label: 'Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const username = (credentials?.username as string | undefined) ?? '';
        const password = (credentials?.password as string | undefined) ?? '';

        if (!username || !password) {
          console.log('[auth] action=login username=%s result=missing_credentials', username);
          return null;
        }

        // Import DB helpers inside authorize() — never at module init time.
        // better-sqlite3 is a native Node module incompatible with Edge runtime;
        // keeping the import lazy ensures this file can be loaded on Edge for proxy.
        const { getUserByUsername } = await import('@/lib/db');
        const { verifyToken } = await import('@/lib/token');

        const user = getUserByUsername(username);
        if (!user) {
          console.log('[auth] action=login username=%s result=user_not_found', username);
          return null;
        }

        const valid = await verifyToken(password, user.password_hash);
        if (!valid) {
          console.log('[auth] action=login username=%s result=invalid_password', username);
          return null;
        }

        console.log('[auth] action=login username=%s result=success', username);
        return {
          id: String(user.id),
          username: user.username,
          permissions: user.permissions,
          // next-auth surfaces name in the default session.user.name field
          name: user.username,
        };
      },
    }),
    ...(oidcEnabled ? [oidcProvider] : []),
  ],

  callbacks: {
    async jwt({ token, user }) {
      // On initial sign-in `user` is populated; persist our custom fields into the token.
      if (user) {
        token.id = user.id as string;
        token.username = (user as { username: string }).username;
        token.permissions = (user as { permissions: Permission[] }).permissions;
      }
      return token;
    },
    async session({ session, token }) {
      // Project custom JWT fields onto the session user object.
      // token extends Record<string, unknown> so we cast explicitly.
      session.user.id = token.id as string;
      session.user.username = token.username as string;
      session.user.permissions = token.permissions as Permission[];
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(config);
