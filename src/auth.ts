import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import type { NextAuthConfig } from 'next-auth';
import type { JWT } from '@auth/core/jwt';
import type { Account, User as NextAuthUser } from 'next-auth';
import type { Permission } from '@/types';

// ── TypeScript module augmentation ──────────────────────────────────────────
// In Auth.js v5 beta, the JWT interface lives in @auth/core/jwt.
// The User/Session interfaces live in next-auth (which re-exports from @auth/core/types).
declare module 'next-auth' {
  interface User {
    id: string;
    username: string;
    email: string | null;
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
    email: string | null;
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

// ── OIDC permission resolution (exported, reusable) ──────────────────────────
/**
 * Subset of OIDC ID-token claims needed to resolve a user's app permissions.
 * Sourced from the verified ID token (UI login) or a brokered device-grant
 * exchange (agent mint route) — both must resolve permissions identically.
 */
export interface OidcUserClaims {
  email?: string | null;
  name?: string | null;
}

/** Result of resolving an OIDC user: the upserted DB identity plus permissions. */
export interface ResolvedOidcUser {
  id: number;
  email: string;
  permissions: Permission[];
}

/**
 * Single source of truth for turning verified OIDC ID-token claims into an
 * app user + permissions. Applies the AUTH_OIDC_ADMIN_DOMAIN auto-promote rule
 * (admin-domain → ['upload','admin'], otherwise []) and upserts the user via
 * upsertOidcUser, returning the persisted identity.
 *
 * Both jwtCallback (UI login) and the agent mint route (t5) call this so an
 * agent receives exactly the permissions it would get logging into the UI.
 */
export async function resolveOidcUserPermissions(
  claims: OidcUserClaims,
): Promise<ResolvedOidcUser> {
  const email = claims.email ?? '';
  const domain = email.split('@')[1] ?? '';
  const adminDomain = process.env.AUTH_OIDC_ADMIN_DOMAIN ?? '';
  const autoPromote = adminDomain !== '' && domain === adminDomain;
  const autoPermissions: Permission[] = autoPromote ? ['upload', 'admin'] : [];

  // Lazy import — keeps better-sqlite3 off the Edge runtime code path
  const { upsertOidcUser } = await import('@/lib/db');
  const dbUser = await upsertOidcUser(email, claims.name ?? email, autoPermissions);

  console.log(
    '[auth] action=oidc-login email=%s domain=%s auto_promote=%s result=success',
    email,
    domain,
    String(autoPromote),
  );

  return { id: dbUser.id, email, permissions: dbUser.permissions };
}

// ── JWT callback (exported for unit tests) ───────────────────────────────────
/**
 * Handles all three jwt() invocation paths:
 *   - session refresh (no user, no account) → return token unchanged
 *   - credentials sign-in (account.type === 'credentials') → copy id/username/permissions
 *   - OIDC sign-in (account.type === 'oidc') → upsert user, apply domain auto-promote
 */
export async function jwtCallback({
  token,
  user,
  account,
}: {
  token: JWT;
  user?: NextAuthUser;
  account?: Account;
}): Promise<JWT> {
  // Session refresh path — neither user nor account present
  if (!user && !account) return token;

  if (account?.type === 'oidc' && user) {
    const resolved = await resolveOidcUserPermissions(user as OidcUserClaims);

    token.id = String(resolved.id);
    token.username = resolved.email;
    token.email = resolved.email;
    token.permissions = resolved.permissions;
    return token;
  }

  // Credentials sign-in path (account.type === 'credentials') or fallback
  if (user) {
    token.id = (user as { id: string }).id;
    token.username = (user as { username: string }).username;
    token.email = (user as { email?: string | null }).email ?? null;
    token.permissions = (user as { permissions: Permission[] }).permissions;
  }
  return token;
}

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
        const { verifyPassword } = await import('@/lib/token');

        const user = getUserByUsername(username);
        if (!user) {
          console.log('[auth] action=login username=%s result=user_not_found', username);
          return null;
        }

        // OIDC users have no password_hash — credentials login must fail for them.
        if (!user.password_hash) return null;
        const valid = await verifyPassword(password, user.password_hash);
        if (!valid) {
          console.log('[auth] action=login username=%s result=invalid_password', username);
          return null;
        }

        console.log('[auth] action=login username=%s result=success', username);
        return {
          id: String(user.id),
          username: user.username,
          email: user.email ?? null,
          permissions: user.permissions,
          // next-auth surfaces name in the default session.user.name field
          name: user.username,
        };
      },
    }),
    ...(oidcEnabled ? [oidcProvider] : []),
  ],

  callbacks: {
    async jwt({ token, user, account }) {
      return jwtCallback({ token: token as JWT, user: user as NextAuthUser | undefined, account: account ?? undefined });
    },
    async session({ session, token }) {
      // Project custom JWT fields onto the session user object.
      // token extends Record<string, unknown> so we cast explicitly.
      session.user.id = token.id as string;
      session.user.username = token.username as string;
      // email can be null for credentials users — cast to bypass AdapterUser.email: string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (session.user as any).email = (token.email as string | null | undefined) ?? null;
      session.user.permissions = token.permissions as Permission[];
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(config);
