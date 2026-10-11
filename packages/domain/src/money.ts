/**
 * Money is always integer paise. Never floats for stored amounts.
 * Business amounts (fees, instalments, tax) are rounded to whole rupees,
 * which is how Indian institutes quote and invoice them.
 */
export type Paise = number;

export const PAISE_PER_RUPEE = 100;

export function rupees(amount: number): Paise {
  return Math.round(amount * PAISE_PER_RUPEE);
}

export function toRupees(paise: Paise): number {
  return paise / PAISE_PER_RUPEE;
}

/** Round to the nearest whole rupee (half away from zero). */
export function roundRupee(paise: Paise): Paise {
  const sign = paise < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(paise) / PAISE_PER_RUPEE) * PAISE_PER_RUPEE;
}

/** pct may be fractional (e.g. 12.5). Result rounded to whole rupee. */
export function percentOf(paise: Paise, pct: number): Paise {
  return roundRupee((paise * pct) / 100);
}

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** ₹15,000 — Indian digit grouping. Shows paise only when non-zero and `exact` is set. */
export function formatINR(paise: Paise, opts: { exact?: boolean } = {}): string {
  const r = paise / PAISE_PER_RUPEE;
  const neg = r < 0 ? '−' : '';
  const abs = Math.abs(r);
  const body = opts.exact && !Number.isInteger(abs) ? inr2.format(abs) : inr.format(Math.round(abs));
  return `${neg}₹${body}`;
}

/** ₹48.6L / ₹2.4Cr / ₹68,000 — compact form used on dashboards. */
export function formatINRCompact(paise: Paise): string {
  const r = Math.abs(paise / PAISE_PER_RUPEE);
  const neg = paise < 0 ? '−' : '';
  if (r >= 1_00_00_000) return `${neg}₹${trim1(r / 1_00_00_000)}Cr`;
  if (r >= 1_00_000) return `${neg}₹${trim1(r / 1_00_000)}L`;
  return `${neg}₹${inr.format(Math.round(r))}`;
}

function trim1(n: number): string {
  const s = (Math.round(n * 10) / 10).toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

export function sumPaise(values: readonly Paise[]): Paise {
  return values.reduce((a, b) => a + b, 0);
}

/**
 * Split `total` into parts by percentage, rounding each to whole rupees and
 * letting the last part absorb the rounding difference so the parts always
 * sum exactly to the total.
 */
export function splitByPercent(total: Paise, percents: readonly number[]): Paise[] {
  if (percents.length === 0) return [];
  const parts: Paise[] = [];
  let allocated = 0;
  percents.forEach((pct, i) => {
    if (i === percents.length - 1) {
      parts.push(total - allocated);
    } else {
      const p = roundRupee((total * pct) / 100);
      parts.push(p);
      allocated += p;
    }
  });
  return parts;
}
