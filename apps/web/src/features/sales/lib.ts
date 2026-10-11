'use client';

import { referenceContract } from '@exatech/contracts';
import { formatDayMonth, toISTDate, toISTTime, todayIST, addDays } from '@exatech/domain';
import type { TagProps } from '@exatech/ui';
import { useApi } from '@/lib/hooks';

/** Sources offered in forms (Import is set by the import job). */
export const FORM_SOURCES = ['Walk-in', 'Instagram', 'Website', 'Google Ads', 'Referral'] as const;

/** Courses, branches, batches, staff — cached for 30 min. */
export function useReference() {
  return useApi(referenceContract.get, {}, { staleTime: 30 * 60_000 });
}

export function stageTag(stage: string): TagProps['variant'] {
  switch (stage) {
    case 'won':
      return 'solid';
    case 'lost':
      return 'ink';
    case 'negotiation':
    case 'admission_in_progress':
      return 'accent';
    case 'new':
      return 'outline';
    default:
      return 'neutral';
  }
}

/** "Today 11:20", "Yesterday 16:04", "Thu 10:12" (this week), "3 Oct 10:12". */
export function activityWhen(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const d = toISTDate(at);
  const today = todayIST(now);
  const t = toISTTime(at);
  if (d === today) return `Today ${t}`;
  if (d === addDays(today, -1)) return `Yesterday ${t}`;
  const days = Math.round((Date.parse(today) - Date.parse(d)) / 86_400_000);
  if (days > 0 && days < 7) return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${d}T00:00:00Z`).getUTCDay()]} ${t}`;
  return `${formatDayMonth(d)} ${t}`;
}

/** Value for <input type="datetime-local"> in IST. */
export function toLocalInput(d: Date): string {
  return `${toISTDate(d)}T${toISTTime(d)}`;
}

/** "2026-10-12T10:30" (IST wall clock) → ISO instant. */
export function fromLocalInput(v: string): string {
  return new Date(`${v}:00+05:30`).toISOString();
}

/** Default next follow-up: tomorrow 10:30 IST. */
export function defaultFollowUp(): string {
  return `${addDays(todayIST(), 1)}T10:30`;
}

export const telHref = (phone: string | null) => (phone ? `tel:${phone}` : undefined);
export const waHref = (phone: string | null, text?: string) => (phone ? `https://wa.me/${phone.replace(/\D/g, '')}${text ? `?text=${encodeURIComponent(text)}` : ''}` : undefined);

/** Fill "{name}" style template variables. */
export function fillTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{(\w+)\}/g, (_m, k: string) => (vars[k]?.trim() ? vars[k]! : `{${k}}`));
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
}
