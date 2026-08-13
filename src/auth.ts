import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import type { NextAuthConfig } from 'next-auth';
import type { JWT } from '@auth/core/jwt';
import type { Account, Profile, User as NextAuthUser } from 'next-auth';
import type { Permission } from '@/types';
import { emailDomain } from '@/lib/oidc-claims';
import {
  clearFailures,
  getClientIp,
  isLockedOut,
  loginIpKey,
  loginUserKey,
  recordFailure,
  type HeaderSource,
} from '@/lib/throttle';

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
  /**
   * The IdP's assertion that it owns the mailbox. Required to be exactly `true`
   * before any domain-based promotion: the admin-domain rule reads the email's
   * domain, so an unverified email means an unverified domain.
   */
  email_verified?: boolean | null;
  /** Google Workspace hosted-domain claim, an alternative domain source. */
  hd?: string | null;
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
 * Both jwtCallback (UI login) and the agent mint route call this so an agent
 * receives exactly the permissions it would get logging into the UI.
 *
 * Throws when the claims cannot support an authorization decision at all (no
 * email, or an email the IdP has not marked verified). The UI path never
 * reaches that throw — signInCallback rejects the sign-in first — and the agent
 * path checks the same claim before calling; the throw is the backstop that
 * keeps a future third caller from re-opening the hole.
 */
export async function resolveOidcUserPermissions(
  claims: OidcUserClaims,
): Promise<ResolvedOidcUser> {
  const email = (claims.email ?? '').trim();
  if (email === '') {
    throw new Error('resolveOidcUserPermissions: ID token carried no email claim');
  }
  if (claims.email_verified !== true) {
    throw new Error('resolveOidcUserPermissions: email_verified claim is not true');
  }

  const domain = emailDomain(email);
  const hd = typeof claims.hd === 'string' && claims.hd.trim() !== '' ? claims.hd.trim().toLowerCase() : null;
  const adminDomain = (process.env.AUTH_OIDC_ADMIN_DOMAIN ?? '').trim().toLowerCase();
  // An address we cannot parse into exactly one domain is never promoted, even
  // if `hd` matches: the stored identity would not correspond to the domain we
  // trusted. `hd` is accepted as an alternative source for a well-formed
  // address whose domain differs from the admin domain (an alias domain),
  // matching the agent mint route's gate.
  const autoPromote =
    adminDomain !== '' && domain !== null && (domain === adminDomain || hd === adminDomain);
  const autoPermissions: Permission[] = autoPromote ? ['upload', 'admin'] : [];

  // Lazy import — keeps better-sqlite3 off the Edge runtime code path
  const { upsertOidcUser } = await import('@/lib/db');
  const dbUser = await upsertOidcUser(email, claims.name ?? email, autoPermissions);

  console.log(
    '[auth] action=oidc-login email=%s domain=%s auto_promote=%s result=success',
    email,
    domain ?? 'unparseable',
    String(autoPromote),
  );

  return { id: dbUser.id, email, permissions: dbUser.permissions };
}

// ── signIn callback (exported for unit tests) ────────────────────────────────
/**
 * Outer gate on the OIDC sign-in: an account the IdP has not marked
 * `email_verified` never gets a session at all. Returning false makes
 * @auth/core throw AccessDenied before the jwt callback runs, so no cookie is
 * ever issued.
 *
 * Credentials (and any non-OIDC) sign-ins pass straight through — they are
 * gated by authorizeCredentials instead.
 *
 * Deployment note: this hard-requires the claim. An IdP that omits
 * `email_verified` entirely will lock SSO users out until it is configured to
 * send it — the same requirement the agent device-grant path already enforces
 * in production.
 */
export function signInCallback({
  account,
  profile,
}: {
  account?: Account | null;
  profile?: Profile | null;
}): boolean {
  if (account?.type !== 'oidc') return true;

  if (profile?.email_verified !== true) {
    console.warn(
      '[auth] action=oidc-login email=%s result=email_unverified',
      profile?.email ?? 'unknown',
    );
    return false;
  }
  return true;
}

// ── JWT callback (exported for unit tests) ───────────────────────────────────
/**
 * Handles all three jwt() invocation paths:
 *   - session refresh (no user, no account) → return token unchanged
 *   - credentials sign-in (account.type === 'credentials') → copy id/username/permissions
 *   - OIDC sign-in (account.type === 'oidc') → upsert user, apply domain auto-promote
 *
 * `profile` matters for the OIDC path: it carries the VALIDATED ID-token claims
 * (@auth/core sets `profile = getValidatedIdTokenClaims(...)` in
 * lib/actions/callback/oauth/callback.js and passes it through to this callback),
 * whereas `user` has been through the default profile mapper, which keeps only
 * id/name/email/image (lib/utils/providers.js). `email_verified` and `hd`
 * therefore exist only on `profile`. Threading it in here — rather than adding a
 * custom `profile()` to the provider — keeps those security-critical optional
 * fields off the augmented `User` that the credentials path could never
 * populate.
 */
export async function jwtCallback({
  token,
  user,
  account,
  profile,
}: {
  token: JWT;
  user?: NextAuthUser;
  account?: Account;
  profile?: Profile;
}): Promise<JWT> {
  // Session refresh path — neither user nor account present
  if (!user && !account) return token;

  if (account?.type === 'oidc' && user) {
    const resolved = await resolveOidcUserPermissions({
      // email comes from `user`, not `profile`: @auth/core has already
      // lower-cased it, and users.email UNIQUE is BINARY in SQLite, so
      // upserting the raw claim could create a second row for the same mailbox
      // and make upsertOidcUser throw.
      email: user.email,
      name: user.name ?? null,
      email_verified: typeof profile?.email_verified === 'boolean' ? profile.email_verified : null,
      hd: typeof profile?.hd === 'string' ? profile.hd : null,
    });

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

// ── Credentials authorize (exported for unit tests) ──────────────────────────
/** The user shape the credentials provider hands back to Auth.js on success. */
export interface CredentialsActor {
  id: string;
  username: string;
  email: string | null;
  permissions: Permission[];
  name: string;
}

/**
 * Verifies a username/password pair, with failed-attempt lockout applied HERE
 * rather than at the proxy.
 *
 * Every credentials login converges on this function no matter which transport
 * carried it — the server-action `POST /login`, the Auth.js
 * `/api/auth/callback/credentials` endpoint, or any future one — so a counter
 * kept here cannot be bypassed by switching transports the way the proxy's
 * path-keyed limiter can. The proxy limiter stays as a cheaper outer layer;
 * see the note at the top of src/lib/throttle.ts about the two independent map
 * instances.
 *
 * Both dimensions are checked: the username (so guessing one account is capped
 * however many IPs it comes from) and the client IP (so stuffing many usernames
 * from one source is capped too). A locked-out attempt returns null WITHOUT
 * recording another failure, so an attacker cannot keep extending a victim's
 * lockout by continuing to hammer it.
 */
export async function authorizeCredentials(
  credentials: Partial<Record<string, unknown>> | undefined,
  request?: HeaderSource,
): Promise<CredentialsActor | null> {
  const username = typeof credentials?.username === 'string' ? credentials.username : '';
  const password = typeof credentials?.password === 'string' ? credentials.password : '';

  if (!username || !password) {
    console.log('[auth] action=login username=%s result=missing_credentials', username);
    return null;
  }

  // next-auth builds the authorize() request from the incoming one and copies
  // its headers across (next-auth/lib/actions.js does `new Headers(await
  // nextHeaders())`), so x-forwarded-for is present on the server-action path
  // too — not just on the direct API POST.
  const userKey = loginUserKey(username);
  // Null when the client IP cannot be resolved (no proxy headers, e.g. local
  // dev): the username dimension still applies, but every such caller must not
  // be lumped into one shared counter.
  const ipKey = request ? loginIpKey(getClientIp(request)) : null;

  if (isLockedOut(userKey) || (ipKey !== null && isLockedOut(ipKey))) {
    // Deliberately refuses even a CORRECT password: otherwise the lockout is
    // only an inconvenience to an attacker who eventually guesses right.
    console.log('[auth] action=login username=%s result=throttled', username);
    return null;
  }

  // Import DB helpers inside authorize() — never at module init time.
  // better-sqlite3 is a native Node module incompatible with Edge runtime;
  // keeping the import lazy ensures this file can be loaded on Edge for proxy.
  // Uses the *ForAuth variant — this is the one production caller that needs
  // password_hash off the users row.
  const { getUserByUsernameForAuth } = await import('@/lib/db');
  const { verifySecret } = await import('@/lib/token');

  const user = getUserByUsernameForAuth(username);
  // One bcrypt compare on every path. An unknown username and an OIDC account
  // (password_hash IS NULL, so credentials login must always fail for it) both
  // compare against a fixed dummy hash instead of returning early, so neither
  // is distinguishable from a wrong password by response time.
  const valid = await verifySecret(password, user?.password_hash ?? null);

  if (!user || !valid) {
    recordFailure(userKey);
    if (ipKey !== null) recordFailure(ipKey);
    console.log(
      '[auth] action=login username=%s result=%s',
      username,
      !user ? 'user_not_found' : 'invalid_password',
    );
    return null;
  }

  clearFailures(userKey);
  if (ipKey !== null) clearFailures(ipKey);

  console.log('[auth] action=login username=%s result=success', username);
  return {
    id: String(user.id),
    username: user.username,
    email: user.email ?? null,
    permissions: user.permissions,
    // next-auth surfaces name in the default session.user.name field
    name: user.username,
  };
}

// ── Auth.js config ────────────────────────────────────────────────────────────
const config: NextAuthConfig = {
  // JWT session strategy — no DB adapter. maxAge caps how long a stale claim
  // can circulate: authorization itself is re-read from the DB on every request
  // (see getIsAdmin / resolveUploadActor), but a shorter session also bounds a
  // stolen cookie's usefulness.
  session: { strategy: 'jwt', maxAge: 8 * 60 * 60 },

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
      authorize(credentials, request) {
        return authorizeCredentials(credentials, request);
      },
    }),
    ...(oidcEnabled ? [oidcProvider] : []),
  ],

  callbacks: {
    signIn({ account, profile }) {
      return signInCallback({ account, profile });
    },
    async jwt({ token, user, account, profile }) {
      return jwtCallback({
        token: token as JWT,
        user: user as NextAuthUser | undefined,
        account: account ?? undefined,
        profile: profile ?? undefined,
      });
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
