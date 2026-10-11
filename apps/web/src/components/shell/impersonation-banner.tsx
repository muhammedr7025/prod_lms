'use client';

import { AUTH_PATHS } from '@exatech/contracts';
import { toISTTime } from '@exatech/domain';
import { useState } from 'react';
import { authPost } from '@/lib/api';
import { useMe } from '../me-context';

/** Shown while a Super Admin is viewing as a student or parent (read-only, time-boxed). */
export function ImpersonationBanner() {
  const me = useMe();
  const [busy, setBusy] = useState(false);
  if (!me.impersonation) return null;
  return (
    <div className="no-print bg-ink text-white text-[13px] px-[18px] py-2 flex items-center gap-3 flex-wrap">
      <span className="w-2 h-2 bg-accent-300" />
      <span>
        Viewing as <b className="font-medium">{me.user.name}</b> · read-only · ends {toISTTime(new Date(me.impersonation.expiresAt))} · started by {me.impersonation.byName}
      </span>
      <span className="flex-1" />
      <button
        type="button"
        disabled={busy}
        className="border border-white/40 bg-transparent text-white px-2.5 py-1 cursor-pointer font-heading font-semibold hover:bg-white/10"
        onClick={async () => {
          setBusy(true);
          await authPost(AUTH_PATHS.stopImpersonation).catch(() => undefined);
          window.location.assign('/');
        }}
      >
        Return to my account
      </button>
    </div>
  );
}
