'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError, AUTH_ERROR_CODES } from '@/lib/api';
import { makeQueryClient } from '@/lib/query-client';

function handleAuthError(err: unknown) {
  if (!(err instanceof ApiError) || typeof window === 'undefined') return;
  const here = window.location.pathname + window.location.search;
  if (AUTH_ERROR_CODES.has(err.code)) {
    const reason = err.code === 'SESSION_IDLE' ? 'idle' : err.code === 'SESSION_EXPIRED' ? 'expired' : 'signin';
    if (!window.location.pathname.startsWith('/sign-in')) window.location.assign(`/sign-in?reason=${reason}&next=${encodeURIComponent(here)}`);
  } else if (err.code === 'TWO_FACTOR_REQUIRED' || err.code === 'TWO_FACTOR_ENROLLMENT_REQUIRED') {
    if (!window.location.pathname.startsWith('/security/2fa')) window.location.assign(`/security/2fa?next=${encodeURIComponent(here)}`);
  }
}

export function Providers({ children }: { children: ReactNode }) {
  // Global auth handling: expired/idle sessions go to sign-in, pending 2FA to the 2FA screen.
  const [client] = useState(() => makeQueryClient(handleAuthError));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
