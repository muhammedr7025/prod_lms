'use client';

import { AUTH_PATHS, coreContract } from '@exatech/contracts';
import { cn, Icon, Kicker, Popover, toast } from '@exatech/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { callApi, keyFor } from '@/lib/api';
import { useMe } from '../me-context';
import { homePath } from './nav';

export function AccountMenu() {
  const me = useMe();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const switchTo = async (membershipId: string) => {
    if (membershipId === me.membership.id) return setOpen(false);
    setBusy(membershipId);
    try {
      const next = await callApi(coreContract.switchMembership, { body: { membershipId } });
      qc.clear();
      qc.setQueryData(keyFor(coreContract.me, {}), next);
      window.location.assign(homePath(next));
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(null);
    }
  };

  const signOut = async () => {
    await fetch(AUTH_PATHS.signOut, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => undefined);
    qc.clear();
    window.location.assign('/sign-in');
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      width={260}
      trigger={
        <button type="button" className="h-[34px] flex items-center gap-2.5 pl-1 pr-2.5 border border-divider bg-transparent cursor-pointer hover:bg-ink/7" aria-label="Account menu">
          <span className="w-[26px] h-[26px] bg-accent-200 text-accent-800 grid place-items-center font-heading font-semibold text-[13px]">{me.user.initials}</span>
          <span className="hidden sm:flex flex-col items-start leading-[1.1] whitespace-nowrap">
            <span className="text-[13px] font-heading font-semibold">{me.user.name}</span>
            <span className="text-[11px] text-accent-700">
              {me.membership.roleLabel} · {me.membership.scopeLabel}
            </span>
          </span>
          <Icon name="chevronDown" size={14} />
        </button>
      }
    >
      <div className="p-2 grid gap-0.5">
        <Kicker className="px-2 py-1.5">Switch membership</Kicker>
        {me.memberships.map((m) => (
          <button
            key={m.id}
            type="button"
            disabled={!!busy || me.readOnly}
            onClick={() => switchTo(m.id)}
            className={cn(
              'flex justify-between items-center gap-2 p-2 border-0 text-[13px] cursor-pointer text-left w-full hover:bg-accent-100 disabled:cursor-wait',
              m.id === me.membership.id ? 'bg-accent-100' : 'bg-transparent',
            )}
          >
            <span>{m.roleLabel}</span>
            <span className="text-[11px] text-neutral-600">{busy === m.id ? 'Switching…' : m.scopeLabel}</span>
          </button>
        ))}
        <div className="border-t border-divider mt-1.5 pt-1.5 grid">
          {me.user.kind === 'staff' && (
            <a href="/security/2fa" className="px-2 py-2 text-[13px] text-ink no-underline hover:bg-accent-100">
              Two-factor authentication · {me.user.twoFactorEnabled ? 'on' : 'off'}
            </a>
          )}
          <a href="/account/notifications" className="px-2 py-2 text-[13px] text-ink no-underline hover:bg-accent-100">
            Notification preferences
          </a>
          <button type="button" onClick={signOut} className="text-left px-2 py-2 text-[13px] border-0 bg-transparent cursor-pointer text-accent hover:bg-accent/10">
            Sign out
          </button>
        </div>
      </div>
    </Popover>
  );
}
