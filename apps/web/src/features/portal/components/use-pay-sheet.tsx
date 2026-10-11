'use client';

import type { PayInfo } from '@exatech/contracts';
import dynamic from 'next/dynamic';
import { useCallback, useState } from 'react';

/** The sheet (checkout flow + payments contract) loads on the first tap of Pay — not part of the portal's first load. */
const PaySheet = dynamic(() => import('./pay-sheet').then((m) => m.PaySheet), { ssr: false });

/** Hook: one pay sheet per screen. `open(pay)` for one child, `open([a, b])` for several. */
export function usePaySheet() {
  const [targets, setTargets] = useState<PayInfo[]>([]);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(false);
  const show = useCallback((t: PayInfo | PayInfo[] | null | undefined, opts: { all?: boolean } = {}) => {
    const list = (Array.isArray(t) ? t : t ? [t] : []).filter(Boolean);
    if (!list.length) return;
    setTargets(list);
    setAll(!!opts.all);
    setUsed(true);
    setOpen(true);
  }, []);
  const element = used ? <PaySheet open={open} onOpenChange={setOpen} targets={targets} all={all} /> : null;
  return { open: show, element };
}
