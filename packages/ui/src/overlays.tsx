'use client';

import { Dialog as D, Popover as P } from 'radix-ui';
import * as React from 'react';
import { cn } from './cn';
import { Corners, Kicker } from './primitives';

/* ───────────────────────── Dialog ───────────────────────── */

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kicker?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  width?: number;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  /** Footer alignment: actions on the right, or a destructive action on the left. */
  footerAlign?: 'end' | 'between' | 'center';
  className?: string;
  center?: boolean;
}

/** Blueprint modal on a dimmed backdrop. Focus is trapped and restored (Radix). */
export function Dialog({ open, onOpenChange, kicker, title, description, width = 440, children, footer, footerAlign = 'end', className, center }: DialogProps) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-[60] bg-neutral-900/50 animate-fade" />
        <D.Content
          className={cn(
            'fixed z-[61] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-h-[90vh] overflow-auto bg-white border border-divider shadow-lg p-[13.6px] flex flex-col gap-[10.2px] animate-rise focus:outline-none',
            center && 'items-center text-center',
            className,
          )}
          style={{ width: `min(${width}px, 94vw)` }}
          aria-describedby={description ? undefined : undefined}
        >
          <Corners />
          {kicker != null && <Kicker>{kicker}</Kicker>}
          <D.Title className="font-heading font-semibold text-xl leading-tight m-0">{title}</D.Title>
          {description != null ? <D.Description className="text-sm opacity-85 m-0">{description}</D.Description> : <D.Description className="sr-only">{typeof title === 'string' ? title : 'Dialog'}</D.Description>}
          {children}
          {footer && (
            <div className={cn('flex gap-[6.8px] mt-[6.8px] flex-wrap', footerAlign === 'end' ? 'justify-end' : footerAlign === 'center' ? 'justify-center' : 'justify-between')}>{footer}</div>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/* ───────────────────────── Sheet (right-side detail drawer) ───────────────────────── */

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  header: React.ReactNode;
  title: string;
  width?: number;
  children: React.ReactNode;
}

export function Sheet({ open, onOpenChange, header, title, width = 640, children }: SheetProps) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-[57] bg-neutral-900/35 animate-fade" />
        <D.Content className="fixed z-[58] top-0 right-0 bottom-0 bg-white border-l border-divider shadow-lg overflow-auto animate-slide-in focus:outline-none" style={{ width: `min(${width}px, 100vw)` }}>
          <D.Title className="sr-only">{title}</D.Title>
          <D.Description className="sr-only">{title} details</D.Description>
          {header}
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export const SheetClose = D.Close;

/* ───────────────────────── Popover ───────────────────────── */

export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  align = 'end',
  width = 260,
  className,
}: {
  trigger: React.ReactNode;
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  align?: 'start' | 'end' | 'center';
  width?: number;
  className?: string;
}) {
  return (
    <P.Root open={open} onOpenChange={onOpenChange}>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal>
        <P.Content
          align={align}
          sideOffset={6}
          className={cn('relative z-[45] bg-white border border-divider shadow-lg animate-rise focus:outline-none', className)}
          style={{ width: `min(${width}px, 92vw)` }}
        >
          <Corners />
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}

export const PopoverClose = P.Close;
