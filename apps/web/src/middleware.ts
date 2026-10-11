import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PREFIXES = ['/sign-in', '/verify', '/api', '/_next', '/favicon', '/manifest', '/icon', '/dev/outbox'];
const SESSION_COOKIES = ['exa.session_token', '__Secure-exa.session_token'];

/**
 * Edge check: no session cookie → sign-in. The API re-verifies every request
 * (expiry, idle timeout, 2FA, role × scope); this only avoids a wasted render.
 */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const headers = new Headers(req.headers);
  headers.set('x-pathname', pathname);
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/') || pathname.startsWith(p))) {
    return NextResponse.next({ request: { headers } });
  }
  const hasSession = SESSION_COOKIES.some((c) => req.cookies.has(c));
  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = '/sign-in';
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
