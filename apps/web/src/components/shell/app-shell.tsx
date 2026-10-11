'use client';

import { coreContract, type Me } from '@exatech/contracts';
import { Button, cn, Icon, Toaster } from '@exatech/ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { callApi, keyFor } from '@/lib/api';
import { DrawerHost } from '../drawers/drawer-host';
import { DrawerProvider } from '../drawers/drawer-context';
import { IdleWatcher } from '../idle-watcher';
import { MeProvider, useMe } from '../me-context';
import { RealtimeBridge } from '../realtime';
import { AccountMenu } from './account-menu';
import { CommandPalette } from './command-palette';
import { ImpersonationBanner } from './impersonation-banner';
import { navFor } from './nav';
import { NotificationBell } from './notification-bell';

export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  return (
    <MeProvider initial={me}>
      <DrawerProvider>
        <ShellInner>{children}</ShellInner>
        <DrawerHost />
      </DrawerProvider>
    </MeProvider>
  );
}

function useNarrow(breakpoint = 900) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [breakpoint]);
  return narrow;
}

function ShellInner({ children }: { children: ReactNode }) {
  const me = useMe();
  const isStaff = me.membership.surface === 'staff';
  const narrow = useNarrow();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => setSidebarOpen(false), [pathname]);
  useEffect(() => {
    if (!isStaff) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isStaff]);

  const showAside = isStaff && (!narrow || sidebarOpen);
  useBrandTheme(me.institution.brandColor);

  return (
    <div className="min-h-screen flex flex-col bg-white text-sm">
      <ImpersonationBanner />
      <header className="no-print h-14 flex items-center gap-3.5 px-[18px] border-b border-divider bg-white sticky top-0 z-20">
        {narrow && isStaff && (
          <Button variant="secondary" size="iconSm" onClick={() => setSidebarOpen((o) => !o)} aria-label="Menu">
            <Icon name="menu" />
          </Button>
        )}
        <Link href="/" className="flex items-center gap-2.5 min-w-0 no-underline text-ink">
          <span className="w-7 h-7 bg-accent grid place-items-center text-white font-heading font-semibold text-base">E</span>
          <span className={cn('font-heading font-semibold text-xl tracking-[0.06em]', narrow && isStaff && 'hidden sm:inline')}>EXATECH</span>
        </Link>
        {isStaff && (
          <>
            <BranchSwitcher />
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="flex-1 min-w-0 max-w-[380px] h-[34px] px-2.5 flex items-center gap-1.5 border border-divider bg-transparent text-neutral-600 cursor-pointer hover:bg-ink/7"
            >
              <Icon name="search" size={15} />
              <span className="flex-1 min-w-0 text-left truncate">Search…</span>
              <span className="text-[11px] border border-divider px-[5px] py-px">⌘K</span>
            </button>
          </>
        )}
        <div className="flex-1" />
        <NotificationBell />
        <AccountMenu />
      </header>

      <div className="flex-1 flex items-stretch">
        {isStaff && narrow && sidebarOpen && <div onClick={() => setSidebarOpen(false)} className="fixed inset-0 top-14 bg-neutral-900/30 z-[25]" aria-hidden />}
        {showAside && <Sidebar overlay={narrow} />}
        <main className="flex-1 min-w-0 bg-white">{isStaff ? children : <PortalFrame>{children}</PortalFrame>}</main>
      </div>

      {isStaff && <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />}
      <Toaster bottom={isStaff ? 24 : 76} />
      <RealtimeBridge branchKey={`${me.membership.id}:${me.branch.selectedId ?? 'all'}`} />
      <IdleWatcher minutes={me.session.idleTimeoutMin} />
    </div>
  );
}

const DEFAULT_BRAND = '#4f9d68';

/**
 * Institution brand colour applied as the primary token at runtime (Settings →
 * Identity). Ramps are derived with color-mix so tints and pressed states follow.
 * Set on :root so portalled dialogs and drawers pick it up too.
 */
function useBrandTheme(brand: string) {
  useEffect(() => {
    if (!/^#[0-9a-f]{6}$/i.test(brand) || brand.toLowerCase() === DEFAULT_BRAND) return;
    const root = document.documentElement.style;
    const vars: Record<string, string> = {
      '--color-accent': brand,
      '--color-accent-100': `color-mix(in srgb, ${brand} 10%, white)`,
      '--color-accent-200': `color-mix(in srgb, ${brand} 22%, white)`,
      '--color-accent-300': `color-mix(in srgb, ${brand} 40%, white)`,
      '--color-accent-400': `color-mix(in srgb, ${brand} 65%, white)`,
      '--color-accent-500': `color-mix(in srgb, ${brand} 88%, white)`,
      '--color-accent-600': `color-mix(in srgb, ${brand} 85%, black)`,
      '--color-accent-700': `color-mix(in srgb, ${brand} 68%, black)`,
      '--color-accent-800': `color-mix(in srgb, ${brand} 48%, black)`,
      '--color-accent-900': `color-mix(in srgb, ${brand} 32%, black)`,
    };
    for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
    return () => {
      for (const k of Object.keys(vars)) root.removeProperty(k);
    };
  }, [brand]);
}

function BranchSwitcher() {
  const me = useMe();
  const qc = useQueryClient();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const { allowed, selectedId, locked, canSelectAll } = me.branch;
  const value = selectedId ?? '';
  return (
    <select
      aria-label="Branch"
      title="Scope follows your membership"
      disabled={locked || busy}
      value={value}
      onChange={async (e) => {
        setBusy(true);
        try {
          const next = await callApi(coreContract.setBranch, { body: { branchId: e.target.value || null } });
          qc.setQueryData(keyFor(coreContract.me, {}), next);
          await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'api' && q.queryKey[1] !== 'me' && q.queryKey[1] !== 'reference' });
          router.refresh();
        } finally {
          setBusy(false);
        }
      }}
      className="h-[34px] px-2.5 text-[13px] bg-white border border-divider text-ink disabled:opacity-70 disabled:cursor-not-allowed max-w-[160px]"
    >
      {allowed.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name}
        </option>
      ))}
      {canSelectAll && <option value="">All branches</option>}
    </select>
  );
}

function Sidebar({ overlay }: { overlay: boolean }) {
  const me = useMe();
  const pathname = usePathname();
  const items = navFor(me);
  const active = items
    .filter((i): i is Extract<typeof i, { kind: 'item' }> => i.kind === 'item')
    .filter((i) => pathname === i.screen.path || pathname.startsWith(i.screen.path + '/'))
    .sort((a, b) => b.screen.path.length - a.screen.path.length)[0]?.key;
  return (
    <aside
      className={cn(
        'no-print w-[220px] flex-none border-r border-divider bg-surface pt-3.5 pb-[18px] px-2.5 flex flex-col gap-0.5 overflow-auto top-14 h-[calc(100vh-56px)]',
        overlay ? 'fixed left-0 z-[26] shadow-lg' : 'sticky',
      )}
    >
      {items.map((item, i) =>
        item.kind === 'head' ? (
          <div key={`h${i}`} className="text-[10px] tracking-[0.1em] uppercase text-accent px-2.5 pt-3 pb-1.5">
            {item.label}
          </div>
        ) : (
          <Link
            key={item.key}
            href={item.screen.path}
            aria-current={active === item.key ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2.5 px-2.5 py-[7px] border border-transparent text-[13.5px] no-underline',
              active === item.key ? 'bg-white border-divider text-accent-800 font-medium' : 'text-ink hover:bg-accent-100 hover:text-ink',
            )}
          >
            <Icon name={item.screen.icon} />
            <span className="flex-1">{item.screen.label}</span>
          </Link>
        ),
      )}
      <div className="flex-1" />
      <div className="relative border border-divider p-2.5 bg-white text-xs text-neutral-700">
        <i className="corner tl" />
        <i className="corner tr" />
        <i className="corner bl" />
        <i className="corner br" />
        <div className="flex justify-between">
          <span>Session</span>
          <span className="text-[11px] tracking-[0.02em] px-2.5 py-[3px] bg-accent-100 text-accent-800">Active</span>
        </div>
        <div className="mt-1">
          {me.session.idleTimeoutMin ? `Idle timeout ${me.session.idleTimeoutMin} min` : 'Rolling session'} · 2FA {me.session.twoFactor ? 'on' : 'off'}
        </div>
      </div>
    </aside>
  );
}

function PortalFrame({ children }: { children: ReactNode }) {
  const me = useMe();
  const pathname = usePathname();
  const items = navFor(me).filter((n): n is Extract<typeof n, { kind: 'item' }> => n.kind === 'item');
  const active = items.filter((i) => pathname === i.screen.path || pathname.startsWith(i.screen.path + '/')).sort((a, b) => b.screen.path.length - a.screen.path.length)[0]?.key;
  return (
    <div className="min-h-[calc(100vh-56px)] bg-surface grid justify-items-center px-4 pt-[18px] pb-24">
      <div className="w-full max-w-[480px] grid gap-3.5 content-start animate-rise">{children}</div>
      <nav className="no-print fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[480px] bg-white border-t border-divider grid grid-flow-col auto-cols-fr z-20 shadow-md">
        {items.map((item) => (
          <Link
            key={item.key}
            href={item.screen.path}
            aria-current={active === item.key ? 'page' : undefined}
            className={cn(
              'grid justify-items-center gap-[3px] pt-2.5 pb-2 px-1 min-h-[58px] border-t-2 text-[11px] no-underline',
              active === item.key ? 'border-accent text-accent-800' : 'border-transparent text-neutral-600',
            )}
          >
            <Icon name={item.screen.icon} size={20} />
            {item.screen.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
