'use client';

import type { ApiErrorBody } from '@exatech/contracts';
import { Card, CardTitle, cn, Kicker } from '@exatech/ui';
import { useEffect, useState, type ReactNode } from 'react';
import type { ApiError } from '@/lib/api';

/** KPI tile inside detail drawers (26 px figure, blueprint corners). */
export function DrawerKpi({ label, value, meta, small }: { label: string; value: ReactNode; meta?: ReactNode; small?: boolean }) {
  return (
    <Card pad="sm" className="gap-0.5 px-3 py-2.5">
      <Kicker>{label}</Kicker>
      <div className={cn('font-heading font-semibold leading-none tabular', small ? 'text-[13px] leading-snug mt-1' : 'text-[26px]')}>{value}</div>
      {meta != null && <div className="text-[11px] text-ink/50">{meta}</div>}
    </Card>
  );
}

/** Label / value rows in a card (drawer "Details"). */
export function Facts({ title, rows, labelWidth = 110, children }: { title: string; rows: [string, ReactNode][]; labelWidth?: number; children?: ReactNode }) {
  return (
    <Card pad="md" className="gap-0">
      <CardTitle className="mb-1.5">{title}</CardTitle>
      {rows.map(([label, value], i) => (
        <div key={label} className={cn('grid gap-2.5 py-1.5 text-[13px]', i < rows.length - 1 && 'border-b border-divider')} style={{ gridTemplateColumns: `${labelWidth}px 1fr` }}>
          <span className="text-neutral-600">{label}</span>
          <span className="min-w-0 break-words">{value}</span>
        </div>
      ))}
      {children}
    </Card>
  );
}

/** Seconds since an instant, ticking every 5 s ("refreshed 12 s ago"). null until mounted (no SSR clock mismatch). */
export function useSecondsSince(iso: string | null | undefined): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  if (!iso || now === null) return null;
  return Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
}

export type FieldErrors = Record<string, string>;

/** Field errors from an API error (validation failures carry `fields`). */
export function apiErrors(error: ApiError | null | undefined): FieldErrors {
  if (!error) return {};
  const fields = (error.fields ?? {}) as NonNullable<ApiErrorBody['error']['fields']>;
  return { ...fields, _: error.message };
}

/** "₹19,30,000" → paise; empty / invalid → null. */
export function rupeesToPaise(value: string): number | null {
  const v = value.replace(/[₹,\s]/g, '');
  if (v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n) * 100;
}
