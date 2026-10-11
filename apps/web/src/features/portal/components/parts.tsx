'use client';

import type { FeeCard, NoteItem, PortalChild } from '@exatech/contracts';
import { Button, Card, CardTitle, cn, EmptyState, Kicker, Skeleton, Tag } from '@exatech/ui';
import type { ReactNode } from 'react';

/** Portal screen header: kicker + h2 (+ action), as in the prototype's portal screens. */
export function ScreenHeader({ label, kicker, title, action, className }: { label: string; kicker: ReactNode; title: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div data-screen-label={label} className={cn('flex justify-between items-end gap-2', className)}>
      <div className="min-w-0">
        <Kicker>{kicker ?? <Skeleton className="h-3 w-40" />}</Kicker>
        <h2 className="m-0 text-[32px] leading-[1.12] tracking-[-0.015em]">{title ?? <Skeleton className="h-8 w-48 mt-1" />}</h2>
      </div>
      {action}
    </div>
  );
}

/** Error card for a failed portal query (message is safe to show). */
export function LoadError({ what, error, onRetry }: { what: string; error: { message: string }; onRetry?: () => void }) {
  return (
    <Card tone="white" pad="none">
      <EmptyState
        className="py-6"
        title={`Could not load ${what}`}
        body={error.message}
        action={
          onRetry && (
            <Button size="lg" onClick={onRetry}>
              Try again
            </Button>
          )
        }
      />
    </Card>
  );
}

/** Fees card (Home): headline, sub line, Pay now or Cleared; ink border when overdue. */
export function FeeCardView({ fee, onPay, testId = 'fee-card' }: { fee: FeeCard | undefined; onPay?: () => void; testId?: string }) {
  if (!fee) return <Skeleton className="h-[86px]" />;
  const due = fee.state !== 'cleared';
  return (
    <Card tone={fee.state === 'overdue' ? 'ink' : 'white'} className="p-3.5 gap-2.5" data-testid={testId} data-state={fee.state}>
      <div className="flex justify-between items-center gap-2.5">
        <div className="min-w-0">
          <Kicker>Fees</Kicker>
          <CardTitle>{fee.headline}</CardTitle>
          <div className="text-xs text-neutral-600">{fee.sub}</div>
        </div>
        {due && onPay ? (
          <Button variant="primary" size="lg" className="flex-none" onClick={onPay}>
            Pay now
          </Button>
        ) : (
          !due && (
            <Tag variant="accent" className="flex-none">
              Cleared
            </Tag>
          )
        )}
      </div>
    </Card>
  );
}

/** Child switcher (parent): cards with initials, first name and batch; selected = accent border. */
export function ChildSwitcher({ items, selectedId, onSelect }: { items: PortalChild[] | undefined; selectedId: string | undefined; onSelect: (id: string) => void }) {
  if (!items) return <Skeleton className="h-12" />;
  if (items.length < 2) return null;
  return (
    <div className="flex gap-1.5" role="radiogroup" aria-label="Child">
      {items.map((k) => {
        const on = k.studentId === selectedId;
        return (
          <button
            key={k.studentId}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onSelect(k.studentId)}
            data-testid="child-chip"
            className={cn(
              'relative flex-1 min-w-0 flex items-center gap-2.5 px-3 py-2 min-h-12 border text-left cursor-pointer font-[inherit] text-[inherit] transition-colors focus-visible:outline-2 focus-visible:outline-accent',
              on ? 'bg-white border-accent' : 'bg-transparent border-divider hover:bg-accent-100',
            )}
          >
            <i className="corner tl" aria-hidden />
            <i className="corner tr" aria-hidden />
            <i className="corner bl" aria-hidden />
            <i className="corner br" aria-hidden />
            <span className="w-[30px] h-[30px] flex-none bg-accent-200 text-accent-900 grid place-items-center font-heading font-semibold">{k.initials}</span>
            <span className="min-w-0">
              <span className="block font-medium text-sm truncate">{k.firstName}</span>
              <span className="block text-[11px] text-neutral-600 truncate">{k.batchCode}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

const TYPE_ICON: Record<NoteItem['type'], string> = {
  PDF: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
  Slides: 'M2 3h20v14H2zM8 21h8M12 17v4',
  Video: 'M23 7l-7 5 7 5V7zM1 5h15v14H1z',
  XLSX: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18',
  ZIP: 'M21 8v13H3V8M1 3h22v5H1zM10 12h4',
  Link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
};

/** 28 px framed type icon used in note rows. */
export function TypeIcon({ type }: { type: NoteItem['type'] }) {
  return (
    <span className="w-7 h-7 flex-none grid place-items-center border border-divider text-neutral-700" aria-hidden>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d={TYPE_ICON[type]} />
      </svg>
    </span>
  );
}

/** Segmented choice with two-line labels that fits a phone-width dialog (≥ 48 px targets). */
export function ChoiceSeg<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; top: string; bottom?: string }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex border border-divider">
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'flex-1 min-w-0 min-h-12 px-1.5 py-1.5 grid content-center justify-items-center text-center text-[13px] leading-tight cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2',
              i > 0 && 'border-l border-divider',
              on ? 'bg-accent text-white' : 'bg-transparent hover:bg-ink/7',
            )}
          >
            <span>{o.top}</span>
            {o.bottom && <span className={cn('text-[12px] tabular', on ? 'text-white' : 'text-neutral-600')}>{o.bottom}</span>}
          </button>
        );
      })}
    </div>
  );
}
