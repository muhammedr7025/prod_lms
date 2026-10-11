import { formatINR, rupeeInputToPaise } from '@exatech/domain';

/** "15000" / "15,000" / "₹15,000" → paise (whole rupees), null when not a number. */
export function toPaise(value: string): number | null {
  if (value.trim() === '') return null;
  return rupeeInputToPaise(value);
}

/** paise → plain rupee string for inputs ("15000"). */
export const toRupeeInput = (paise: number) => String(Math.round(paise / 100));

export const inr = formatINR;

/** A fresh idempotency key per payment attempt. */
export function newKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The last N months (YYYY-MM) for month pickers, newest first. */
export function recentMonths(n = 12, from = new Date()): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  for (let i = 0; i < n; i++) {
    const v = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    out.push({ value: v, label: d.toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }) });
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
}

/** Open a same-origin document (PDF) in a new tab. */
export function openDoc(url: string) {
  window.open(url, '_blank', 'noopener');
}
