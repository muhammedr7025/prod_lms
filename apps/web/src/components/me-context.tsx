'use client';

import { coreContract, type Me, type Permission } from '@exatech/contracts';
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { callApi, keyFor } from '@/lib/api';

const MeContext = createContext<Me | null>(null);

/** Seeds the `me` query from the server render and keeps it live. */
export function MeProvider({ initial, children }: { initial: Me; children: ReactNode }) {
  const { data } = useQuery({
    queryKey: keyFor(coreContract.me, {}),
    queryFn: () => callApi(coreContract.me, {}),
    initialData: initial,
    staleTime: 60_000,
  });
  return <MeContext.Provider value={data ?? initial}>{children}</MeContext.Provider>;
}

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe() outside <MeProvider>');
  return me;
}

/** Permission check for UI affordances (the server enforces the same rule). */
export function useCan(...perms: Permission[]): boolean {
  const me = useMe();
  return perms.some((p) => me.membership.permissions.includes(p));
}

/** The selected branch (null = all branches in scope). */
export function useBranch() {
  const me = useMe();
  const selected = me.branch.allowed.find((b) => b.id === me.branch.selectedId) ?? null;
  return { selected, label: selected?.name ?? (me.branch.allowed.length === 1 ? me.branch.allowed[0]!.name : 'All branches'), allowed: me.branch.allowed };
}
