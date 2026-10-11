'use client';

import * as React from 'react';
import { cn } from './cn';

export interface ToastOptions {
  /** Reversible actions show Undo for 6 s instead of asking for confirmation. */
  undo?: () => void | Promise<void>;
  tone?: 'default' | 'error';
  durationMs?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
  message: string;
}

type Listener = (items: ToastItem[]) => void;
let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l(items));

/** Fire a toast from anywhere (components, mutation callbacks). */
export function toast(message: string, opts: ToastOptions = {}): void {
  const id = nextId++;
  items = [...items.slice(-2), { id, message, ...opts }];
  emit();
  const ms = opts.durationMs ?? (opts.undo ? 6000 : opts.tone === 'error' ? 6000 : 3200);
  setTimeout(() => dismiss(id), ms);
}

toast.error = (message: string) => toast(message, { tone: 'error' });

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

/** Dark bar at the bottom centre (above the portal bottom nav when present). */
export function Toaster({ bottom = 24 }: { bottom?: number }) {
  const [list, setList] = React.useState<ToastItem[]>([]);
  React.useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return (
    <div className="fixed left-1/2 -translate-x-1/2 z-[70] grid gap-2 justify-items-center pointer-events-none" style={{ bottom }} role="status" aria-live="polite">
      {list.map((t) => (
        <div
          key={t.id}
          className={cn(
            'relative pointer-events-auto bg-ink text-white border border-ink shadow-lg px-4 py-2.5 text-[13px] flex gap-3 items-center animate-rise max-w-[calc(100vw-32px)]',
            t.tone === 'error' && 'outline outline-2 outline-white/30',
          )}
        >
          <span className={cn('w-2 h-2 flex-none', t.tone === 'error' ? 'bg-white' : 'bg-accent-300')} />
          <span className="min-w-0">{t.message}</span>
          {t.undo && (
            <button
              type="button"
              className="border-0 bg-transparent text-accent-300 text-xs cursor-pointer underline underline-offset-[3px] font-[inherit]"
              onClick={() => {
                void t.undo?.();
                dismiss(t.id);
              }}
            >
              Undo
            </button>
          )}
          <button type="button" aria-label="Dismiss" className="border-0 bg-transparent text-white/60 cursor-pointer ml-1 text-sm leading-none" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
