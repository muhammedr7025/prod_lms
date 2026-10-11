'use client';

import * as React from 'react';
import { cn } from './cn';

const inputBase =
  'w-full min-h-9 px-2.5 py-1.5 font-[inherit] text-sm text-ink caret-accent bg-surface border border-divider transition-colors hover:border-ink/45 focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-0 disabled:opacity-60 disabled:cursor-not-allowed placeholder:text-neutral-500';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  tone?: 'surface' | 'white';
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input({ className, invalid, tone = 'surface', ...props }, ref) {
  return <input ref={ref} className={cn(inputBase, tone === 'white' && 'bg-white', invalid && 'border-ink bg-white outline outline-1 outline-ink', className)} aria-invalid={invalid || undefined} {...props} />;
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean; tone?: 'surface' | 'white' }>(function Textarea(
  { className, invalid, tone = 'surface', ...props },
  ref,
) {
  return <textarea ref={ref} className={cn(inputBase, 'min-h-[90px] resize-y', tone === 'white' && 'bg-white', invalid && 'border-ink', className)} aria-invalid={invalid || undefined} {...props} />;
});

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  options?: readonly (SelectOption | string)[];
  placeholder?: string;
  invalid?: boolean;
  tone?: 'surface' | 'white';
  children?: React.ReactNode;
}

/** Native select (fast, accessible, mobile-friendly) styled as a DS input. */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select({ className, options, placeholder, invalid, tone = 'surface', children, ...props }, ref) {
  return (
    <select ref={ref} className={cn(inputBase, 'w-full pr-7 appearance-auto', tone === 'white' && 'bg-white', invalid && 'border-ink', className)} aria-invalid={invalid || undefined} {...props}>
      {placeholder != null && <option value="">{placeholder}</option>}
      {options?.map((o) => {
        const opt = typeof o === 'string' ? { value: o, label: o } : o;
        return (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        );
      })}
      {children}
    </select>
  );
});

export interface FieldProps {
  label: React.ReactNode;
  error?: string | null;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
  htmlFor?: string;
}

/**
 * Label + control + inline error. The label is associated with the control
 * (htmlFor/id are wired automatically) and errors are announced.
 */
export function Field({ label, error, hint, className, children, htmlFor }: FieldProps) {
  const autoId = React.useId();
  const errorId = `${autoId}-err`;
  const only = React.Children.count(children) === 1 && React.isValidElement(children) ? (children as React.ReactElement<{ id?: string; 'aria-describedby'?: string }>) : null;
  const controlId = htmlFor ?? only?.props.id ?? autoId;
  const control = only
    ? React.cloneElement(only, {
        id: controlId,
        'aria-describedby': [only.props['aria-describedby'], error ? errorId : null].filter(Boolean).join(' ') || undefined,
      })
    : children;
  return (
    <div className={cn('grid gap-[5px] content-start min-w-0', className)}>
      <label htmlFor={only || htmlFor ? controlId : undefined} className="block text-xs text-ink/70">
        {label}
      </label>
      {control}
      {hint && !error && <div className="text-[11px] text-neutral-600">{hint}</div>}
      {error && (
        <div id={errorId} role="alert" className="text-[12px] text-ink font-medium">
          {error}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Segmented control ───────────────────────── */

export interface SegProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: React.ReactNode; disabled?: boolean }[];
  className?: string;
  full?: boolean;
  size?: 'md' | 'lg';
  /** Let long labels wrap onto two lines (narrow phone layouts). */
  wrap?: boolean;
  'aria-label'?: string;
}

export function Seg<T extends string>({ value, onChange, options, className, full, size = 'md', wrap, ...rest }: SegProps<T>) {
  return (
    <div role="radiogroup" aria-label={rest['aria-label']} className={cn('inline-flex border border-divider overflow-hidden', full && 'flex w-full', className)}>
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 px-3 text-[13px] cursor-pointer',
              wrap ? 'whitespace-normal text-center leading-tight py-1.5' : 'whitespace-nowrap',
              ' transition-colors focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2 disabled:opacity-45',
              size === 'lg' ? 'min-h-10' : 'py-[7px]',
              i > 0 && 'border-l border-divider',
              full && 'flex-1',
              checked ? 'bg-accent text-white' : 'bg-transparent hover:bg-ink/7',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ───────────────────────── Checkbox & radio (DS .radio .dot) ───────────────────────── */

export function Checkbox({ checked, onChange, label, className, disabled, align = 'center' }: { checked: boolean; onChange: (v: boolean) => void; label: React.ReactNode; className?: string; disabled?: boolean; align?: 'center' | 'start' }) {
  return (
    <label className={cn('inline-flex gap-2 cursor-pointer text-[13px]', align === 'start' ? 'items-start' : 'items-center', disabled && 'opacity-50 cursor-not-allowed', className)}>
      <input type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span
        aria-hidden
        className={cn(
          'w-4 h-4 flex-none border-[1.5px] border-divider grid place-items-center peer-focus-visible:outline-2 peer-focus-visible:outline-accent peer-focus-visible:outline-offset-2',
          align === 'start' && 'mt-[3px]',
          checked && 'border-accent bg-accent',
        )}
      >
        {checked && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12l5 5L20 7" />
          </svg>
        )}
      </span>
      <span>{label}</span>
    </label>
  );
}

export function Radio({ checked, onChange, label, name, className }: { checked: boolean; onChange: () => void; label: React.ReactNode; name: string; className?: string }) {
  return (
    <label className={cn('inline-flex items-center gap-2 cursor-pointer text-sm', className)}>
      <input type="radio" name={name} className="peer sr-only" checked={checked} onChange={onChange} />
      <span
        aria-hidden
        className={cn(
          'w-4 h-4 flex-none rounded-full border-[1.5px] border-divider peer-hover:border-accent peer-focus-visible:outline-2 peer-focus-visible:outline-accent peer-focus-visible:outline-offset-2',
          checked && 'border-accent bg-accent shadow-[inset_0_0_0_4px_#fff]',
        )}
      />
      <span>{label}</span>
    </label>
  );
}

/* ───────────────────────── Table ───────────────────────── */

export function TableScroll({ minWidth, className, children }: { minWidth?: number; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('overflow-x-auto', className)}>
      <div style={minWidth ? { minWidth } : undefined}>{children}</div>
    </div>
  );
}

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full border-collapse text-sm', className)} {...props} />;
}

export function TH({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn('text-left text-[11px] tracking-[0.08em] uppercase text-ink/60 font-normal px-[6.8px] py-[6.8px] border-b border-divider first:pl-4 whitespace-nowrap', className)} {...props} />;
}

export function TD({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-[6.8px] py-[6.8px] border-b border-ink/8 align-middle first:pl-4', className)} {...props} />;
}

export function TR({ className, onClick, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('hover:bg-ink/4', onClick && 'cursor-pointer', className)} onClick={onClick} {...props} />;
}

/** Secondary text line under a cell's main value. */
export function Sub({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('text-xs text-neutral-600 font-normal', className)} {...props} />;
}

export function Mono({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('font-mono text-xs', className)} {...props} />;
}
