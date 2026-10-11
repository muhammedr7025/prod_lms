import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PREFIXES = ['/sign-in', '/verify', '/api', '/_next', '/favicon', '/manifest', '/icon', '/dev/outbox'];
const SESSION_COOKIES = ['exa.session_token', '__Secure-exa.session_token'];

/**
 * Strict, nonce-based Content-Security-Policy. Next.js applies the nonce to
 * its own scripts (it reads it from the request's CSP header); scripts they
 * load (e.g. Razorpay Checkout) are trusted through 'strict-dynamic'.
 */
function contentSecurityPolicy(nonce: string): string {
  const dev = process.env.NODE_ENV !== 'production';
  const s3 = process.env.S3_PUBLIC_ORIGIN ?? (dev ? 'http://localhost:9000' : '');
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://checkout.razorpay.com${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https://*.razorpay.com ${s3}`.trim(),
    "font-src 'self' data:",
    `connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com${dev ? ' ws: wss:' : ''}`,
    `frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com ${s3}`.trim(),
    `media-src 'self' blob: ${s3}`.trim(),
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Edge check: no session cookie → sign-in. The API re-verifies every request
 * (expiry, idle timeout, 2FA, role × scope); this only avoids a wasted render.
 */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce);
  const headers = new Headers(req.headers);
  headers.set('x-pathname', pathname);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);

  const isPublic = PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
  if (!isPublic && !SESSION_COOKIES.some((c) => req.cookies.has(c))) {
    const url = req.nextUrl.clone();
    url.pathname = '/sign-in';
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }
  const res = NextResponse.next({ request: { headers } });
  if (!pathname.startsWith('/api')) res.headers.set('Content-Security-Policy', csp);
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest).*)'],
};
