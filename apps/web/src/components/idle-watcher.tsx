'use client';

import { AUTH_PATHS } from '@exatech/contracts';
import { useEffect, useRef } from 'react';

/**
 * Staff sessions sign out after N idle minutes (the API enforces the same
 * rule; this just makes it visible immediately instead of on the next call).
 */
export function IdleWatcher({ minutes }: { minutes: number | null }) {
  const last = useRef(Date.now());
  useEffect(() => {
    if (!minutes) return;
    const bump = () => {
      last.current = Date.now();
    };
    const events = ['mousemove', 'keydown', 'pointerdown', 'scroll', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const timer = setInterval(async () => {
      if (Date.now() - last.current > minutes * 60_000) {
        clearInterval(timer);
        await fetch(AUTH_PATHS.signOut, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => undefined);
        window.location.assign('/sign-in?reason=idle');
      }
    }, 30_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, bump));
      clearInterval(timer);
    };
  }, [minutes]);
  return null;
}
