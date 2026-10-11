'use client';

import { cn, Issue, Kicker, Skeleton } from '@exatech/ui';
import type { ReactNode } from 'react';

/** Portal screen header (kicker + h2 + optional action), as in the prototype's teacher screens. */
export function ScreenHeader({ label, kicker, title, action, className }: { label: string; kicker: ReactNode; title: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div data-screen-label={label} className={cn('flex justify-between items-end gap-2', className)}>
      <div className="min-w-0">
        <Kicker>{kicker ?? <Skeleton className="h-3 w-40" />}</Kicker>
        <h2 className="m-0 text-[32px] leading-[1.12] tracking-[-0.015em]">{title}</h2>
      </div>
      {action}
    </div>
  );
}

/** Number that slides in when it changes (150 ms CSS; static under prefers-reduced-motion). */
export function AnimatedCount({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn('relative inline-grid overflow-hidden', className)}>
      <span key={value} className="col-start-1 row-start-1 motion-safe:animate-count-in">
        {value}
      </span>
    </span>
  );
}

/** "Needed" lines for dialogs. */
export function NeededList({ items }: { items: readonly string[] }) {
  if (!items.length) return null;
  return (
    <div className="grid gap-1">
      {items.map((x) => (
        <Issue key={x} kind="needed">
          {x}
        </Issue>
      ))}
    </div>
  );
}

/** Today in IST as YYYY-MM-DD (client side, for date input minimums). */
export function todayISTClient(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

export function addDaysClient(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** IST "YYYY-MM-DDTHH:MM" for datetime-local inputs from an ISO instant. */
export function toLocalInput(iso: string): string {
  return new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 16);
}
