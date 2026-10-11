import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from './cn';

/* ───────────────────────── Corners (registration marks) ───────────────────────── */

export function Corners() {
  return (
    <>
      <i className="corner tl" aria-hidden />
      <i className="corner tr" aria-hidden />
      <i className="corner bl" aria-hidden />
      <i className="corner br" aria-hidden />
    </>
  );
}

/* ───────────────────────── Button ───────────────────────── */

export const buttonVariants = cva(
  'relative inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-heading font-semibold text-sm leading-tight border cursor-pointer select-none transition-colors duration-150 disabled:opacity-45 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-white border-accent hover:bg-accent-600 active:bg-accent-700',
        secondary: 'bg-transparent text-ink border-divider hover:bg-ink/7 active:bg-ink/14',
        ghost: 'bg-transparent text-accent border-transparent hover:bg-accent/10 active:bg-accent/18 px-1.5',
        ink: 'bg-ink text-white border-ink hover:bg-neutral-800',
        white: 'bg-white text-ink border-divider hover:bg-accent-100 hover:border-accent',
      },
      size: {
        sm: 'px-2.5 py-1 text-sm',
        md: 'px-3 py-[6.8px]',
        lg: 'min-h-11 px-4',
        xl: 'min-h-12 px-4 text-[15px]',
        icon: 'w-9 h-9 p-0',
        iconSm: 'w-[34px] h-[34px] p-0',
      },
      block: { true: 'w-full', false: '' },
    },
    compoundVariants: [{ variant: 'ghost', size: 'md', className: 'px-1.5' }],
    defaultVariants: { variant: 'secondary', size: 'md', block: false },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Frame the button as a blueprint object (corner marks) — use for the primary CTA. */
  blueprint?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, block, blueprint, loading, children, disabled, type = 'button', ...props },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cn(buttonVariants({ variant, size, block }), className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {blueprint && <Corners />}
      {loading && <Spinner className="mr-1" />}
      {children}
    </button>
  );
});

export function Spinner({ className, size = 14 }: { className?: string; size?: number }) {
  return (
    <svg className={cn('animate-spin-exa', className)} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M21 12a9 9 0 1 1-6.2-8.56" strokeLinecap="round" />
    </svg>
  );
}

/* ───────────────────────── Tag ───────────────────────── */

export const tagVariants = cva('inline-flex items-center whitespace-nowrap text-[11px] tracking-[0.02em] px-2.5 py-[3px] leading-normal', {
  variants: {
    variant: {
      accent: 'bg-accent-100 text-accent-800',
      neutral: 'bg-neutral-100 text-neutral-800',
      outline: 'border border-accent text-accent-700',
      ink: 'bg-ink text-white',
      solid: 'bg-accent text-white',
      plain: 'border border-divider text-ink',
    },
    size: { sm: 'text-[10px] px-1.5 py-px', md: '' },
  },
  defaultVariants: { variant: 'neutral', size: 'md' },
});

export interface TagProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof tagVariants> {}

export function Tag({ className, variant, size, ...props }: TagProps) {
  return <span className={cn(tagVariants({ variant, size }), className)} {...props} />;
}

/* ───────────────────────── Card ───────────────────────── */

export const cardVariants = cva('relative flex flex-col min-w-0 border', {
  variants: {
    tone: {
      line: 'bg-transparent border-divider',
      white: 'bg-white border-divider',
      tint: 'bg-accent-100 border-divider',
      surface: 'bg-surface border-divider',
      ink: 'bg-white border-ink',
      accent: 'bg-white border-accent',
      dashed: 'bg-transparent border-divider border-dashed',
    },
    pad: { none: 'p-0 gap-0', sm: 'p-3 gap-1.5', md: 'px-4 py-3.5 gap-2', lg: 'p-4 gap-2.5', xl: 'p-[18px] gap-3.5' },
  },
  defaultVariants: { tone: 'white', pad: 'lg' },
});

export interface CardProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof cardVariants> {
  /** Blueprint frame with corner registration marks (default on). */
  blueprint?: boolean;
  as?: 'div' | 'section' | 'article' | 'aside';
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(function Card({ className, tone, pad, blueprint = true, as: As = 'div', children, ...props }, ref) {
  return (
    <As ref={ref} className={cn(cardVariants({ tone, pad }), className)} {...props}>
      {blueprint && <Corners />}
      {children}
    </As>
  );
});

/** A card rendered as a button (clickable tiles). */
export const CardButton = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof cardVariants>>(function CardButton(
  { className, tone, pad, children, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(cardVariants({ tone, pad }), 'text-left cursor-pointer font-[inherit] text-[inherit] transition-colors hover:border-accent hover:bg-accent-100 focus-visible:outline-2 focus-visible:outline-accent', className)}
      {...props}
    >
      <Corners />
      {children}
    </button>
  );
});

export function Kicker({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('text-[10px] tracking-[0.1em] uppercase text-accent', className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('font-heading font-semibold text-[17px] leading-tight', className)} {...props} />;
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('text-[13px] opacity-80', className)} {...props} />;
}

export function CardMeta({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center gap-1.5 text-[11px] text-ink/50', className)} {...props} />;
}

/** Card header row with a hairline under it (tables inside cards). */
export function CardHead({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center justify-between gap-2.5 flex-wrap px-4 py-3 border-b border-divider', className)} {...props} />;
}

/* ───────────────────────── Stat / KPI tile ───────────────────────── */

export interface StatProps {
  label: React.ReactNode;
  value: React.ReactNode;
  meta?: React.ReactNode;
  /** Ink frame for the number that needs attention (overdue, conflicts). */
  emphasis?: boolean;
  size?: 'md' | 'lg';
  children?: React.ReactNode;
  className?: string;
  onClick?: () => void;
}

export function Stat({ label, value, meta, emphasis, size = 'lg', children, className, onClick }: StatProps) {
  const inner = (
    <>
      <Kicker className={emphasis ? 'text-ink' : undefined}>{label}</Kicker>
      <div className={cn('font-heading font-semibold leading-[1.05] tabular', size === 'lg' ? 'text-[32px]' : 'text-[28px]')}>{value}</div>
      {children}
      {meta != null && <CardMeta>{meta}</CardMeta>}
    </>
  );
  if (onClick)
    return (
      <CardButton tone={emphasis ? 'ink' : 'white'} pad="md" className={cn('gap-0.5', className)} onClick={onClick}>
        {inner}
      </CardButton>
    );
  return (
    <Card tone={emphasis ? 'ink' : 'white'} pad="md" className={cn('gap-0.5', className)}>
      {inner}
    </Card>
  );
}

/* ───────────────────────── Progress bar ───────────────────────── */

export function Bar({ value, className, height = 4, tone = 'accent', track = 'tint' }: { value: number; className?: string; height?: number; tone?: 'accent' | 'ink' | 'muted'; track?: 'tint' | 'none' }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className={cn(track === 'tint' ? 'bg-accent-100' : '', className)} style={{ height }} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn('h-full transition-[width] duration-300', tone === 'accent' ? 'bg-accent' : tone === 'ink' ? 'bg-ink' : 'bg-accent-300')} style={{ width: `${pct}%` }} />
    </div>
  );
}

/* ───────────────────────── Page header ───────────────────────── */

export function PageHeader({ kicker, title, actions, className }: { kicker?: React.ReactNode; title: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-end justify-between gap-4 flex-wrap', className)}>
      <div className="min-w-0">
        {kicker != null && <Kicker>{kicker}</Kicker>}
        <h2 className="m-0 font-heading font-semibold text-[32px] leading-[1.12] tracking-[-0.015em]">{title}</h2>
      </div>
      {actions && <div className="flex gap-2 flex-wrap items-center">{actions}</div>}
    </div>
  );
}

/** Standard staff page container (24px 28px padding, 20px gaps, rise animation). */
export function Page({ className, label, ...props }: React.HTMLAttributes<HTMLDivElement> & { label?: string }) {
  return <div data-screen-label={label} className={cn('px-4 py-5 md:px-7 md:py-6 grid gap-5 animate-rise content-start', className)} {...props} />;
}

/** Responsive auto-fit grid of tiles. */
export function Grid({ min = 170, gap = 14, className, style, ...props }: React.HTMLAttributes<HTMLDivElement> & { min?: number; gap?: number }) {
  return <div className={cn('grid items-start', className)} style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${min}px), 1fr))`, gap, ...style }} {...props} />;
}

/* ───────────────────────── Empty / skeleton / blockers ───────────────────────── */

export function EmptyState({ title, body, action, className }: { title: React.ReactNode; body?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('px-4 py-8 text-center grid gap-1.5 justify-items-center text-[13px] text-neutral-600', className)}>
      <div className="font-heading font-semibold text-base text-ink">{title}</div>
      {body && <div className="max-w-[46ch]">{body}</div>}
      {action}
    </div>
  );
}

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={cn('bg-accent-100 animate-pulse-exa', className)} style={style} aria-hidden />;
}

/** Inline validation line used by dialogs: "Blocked · reason" / "Needed · reason" / "OK · message". */
export function Issue({ kind = 'blocked', children }: { kind?: 'blocked' | 'needed' | 'ok'; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 items-center text-[13px]">
      <Tag variant={kind === 'ok' ? 'accent' : 'ink'}>{kind === 'ok' ? 'OK' : kind === 'needed' ? 'Needed' : 'Blocked'}</Tag>
      <span>{children}</span>
    </div>
  );
}

/** Row in a list card (label left, value right, hairline under). */
export function Row({ className, last, ...props }: React.HTMLAttributes<HTMLDivElement> & { last?: boolean }) {
  return <div className={cn('flex justify-between gap-2.5 py-1.5 text-[13px]', !last && 'border-b border-divider', className)} {...props} />;
}

/** Underlined link-style button used for names in tables (opens detail drawers). */
export function LinkButton({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn('border-0 bg-transparent p-0 font-[inherit] text-accent-800 cursor-pointer underline underline-offset-[3px] text-left hover:text-accent-900', className)}
      {...props}
    />
  );
}
