'use client';

import { portalContract, type PortalChild } from '@exatech/contracts';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useApi } from '@/lib/hooks';

const CHILD_KEY = 'exa:portal:child';

function readStored(): string | null {
  try {
    return window.localStorage.getItem(CHILD_KEY);
  } catch {
    return null;
  }
}

/**
 * Parent child switcher state. The selection lives in the URL (`?child=`) so
 * every parent screen is linkable, and in localStorage so the bottom nav
 * (plain links) keeps it.
 */
export function useChildSelection() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const urlChild = params.get('child');
  const kids = useApi(portalContract.children, {});
  /** undefined until localStorage has been read (avoid syncing the URL to the wrong child). */
  const [stored, setStored] = useState<string | null | undefined>(undefined);
  useEffect(() => setStored(readStored()), []);

  const items = kids.data?.items;
  const valid = (id: string | null | undefined): id is string => !!id && !!items?.some((k) => k.studentId === id);
  const selectedId = items
    ? valid(urlChild)
      ? urlChild
      : stored === undefined
        ? undefined
        : valid(stored)
          ? stored
          : items[0]?.studentId
    : (urlChild ?? undefined);
  const selected: PortalChild | undefined = items?.find((k) => k.studentId === selectedId);

  // A linked ?child= becomes the remembered choice.
  useEffect(() => {
    if (!items || stored === undefined || !urlChild || urlChild === stored || !items.some((k) => k.studentId === urlChild)) return;
    try {
      window.localStorage.setItem(CHILD_KEY, urlChild);
    } catch {
      /* private mode */
    }
    setStored(urlChild);
  }, [items, stored, urlChild]);

  // Keep the URL in sync (bottom-nav links arrive without ?child=).
  useEffect(() => {
    if (!items || !selectedId || stored === undefined || urlChild === selectedId) return;
    const sp = new URLSearchParams(params.toString());
    sp.set('child', selectedId);
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  }, [items, selectedId, stored, urlChild, params, pathname, router]);

  const select = useCallback(
    (id: string) => {
      try {
        window.localStorage.setItem(CHILD_KEY, id);
      } catch {
        /* private mode */
      }
      setStored(id);
      const sp = new URLSearchParams(params.toString());
      sp.set('child', id);
      router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  return { items, selected, studentId: selected?.studentId, select, isPending: kids.isPending, error: kids.error };
}

/** Print a same-origin PDF through a hidden iframe (falls back to a new tab). */
export function printPdf(url: string) {
  const frame = document.createElement('iframe');
  frame.style.position = 'fixed';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  frame.setAttribute('aria-hidden', 'true');
  frame.src = url;
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch {
      window.open(url, '_blank', 'noopener');
    }
    setTimeout(() => frame.remove(), 60_000);
  };
  document.body.appendChild(frame);
}

/** Rupee input ("15,000" / "15000.00") → paise, or null. */
export function rupeesToPaise(v: string): number | null {
  const n = Number(v.replace(/[,\s₹]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
