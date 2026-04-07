import { auth } from '@/auth';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

function isPublicRoute(pathname: string): boolean {
  // Auth.js own API routes
  if (pathname.startsWith('/api/auth/')) return true;
  // Login page
  if (pathname === '/login') return true;
  // Logout route — must be public so unauthenticated browsers aren't redirect-looped
  if (pathname === '/logout') return true;
  // Home page
  if (pathname === '/') return true;
  // Download route: /[sha256] — single path segment, no further nesting
  // Matches paths like /abc123def456... but NOT /admin or /upload
  if (/^\/[a-f0-9]{64}(\?.*)?$/i.test(pathname)) return true;
  // Generic download form page
  if (pathname === '/download') return true;
  // Download API
  if (pathname.startsWith('/api/download/')) return true;
  // Public group pages: /g/[slug]
  if (pathname.startsWith('/g/')) return true;
  // Group file download API
  if (pathname.startsWith('/api/groups/')) return true;
  return false;
}

function requiresAdmin(pathname: string): boolean {
  return pathname.startsWith('/admin') || pathname.startsWith('/api/admin');
}

function requiresUpload(pathname: string): boolean {
  return pathname === '/upload' || pathname.startsWith('/api/upload');
}

export default auth(async function proxy(req) {
  const { pathname } = req.nextUrl;
  const session = req.auth;

  if (isPublicRoute(pathname)) {
    return NextResponse.next();
  }

  // Not authenticated — redirect to /login with callbackUrl
  if (!session) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('callbackUrl', req.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  const permissions: string[] = session.user?.permissions ?? [];

  if (requiresAdmin(pathname)) {
    if (!permissions.includes('admin')) {
      // Authenticated but insufficient permissions
      return new NextResponse(
        JSON.stringify({ error: 'Forbidden', phase: 'auth' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  if (requiresUpload(pathname)) {
    if (!permissions.includes('upload') && !permissions.includes('admin')) {
      return new NextResponse(
        JSON.stringify({ error: 'Forbidden', phase: 'auth' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     * - public folder assets
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
