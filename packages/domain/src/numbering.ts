/**
 * Document numbering patterns, e.g.
 *   "{BRANCH}/RCPT/{FY}/{SEQ:6}"       → "TVM/RCPT/2026-27/000184"
 *   "{BRANCH}-{COURSE}-{YEAR}-{SEQ:5}" → "TVM-DM-2027-00142"
 * Sequences are gap-free per branch per FY: the counter row is locked in the
 * same transaction that writes the document (see the API numbering service).
 */
export interface NumberVars {
  BRANCH?: string;
  COURSE?: string;
  FY?: string;
  YEAR?: string | number;
  SEQ: number;
}

const TOKEN = /\{(BRANCH|COURSE|FY|YEAR|SEQ)(?::(\d+))?\}/g;

export function formatNumber(pattern: string, vars: NumberVars): string {
  return pattern.replace(TOKEN, (_m, key: string, width?: string) => {
    if (key === 'SEQ') return String(vars.SEQ).padStart(width ? Number(width) : 1, '0');
    const v = vars[key as keyof NumberVars];
    if (v == null || v === '') throw new Error(`Missing ${key} for number pattern ${pattern}`);
    return String(v);
  });
}

export function validatePattern(pattern: string): { ok: boolean; reason?: string } {
  if (!pattern.includes('{SEQ')) return { ok: false, reason: 'Pattern must contain {SEQ} or {SEQ:n}' };
  const stripped = pattern.replace(TOKEN, '');
  if (/[{}]/.test(stripped)) return { ok: false, reason: 'Unknown placeholder — use BRANCH, COURSE, FY, YEAR, SEQ' };
  return { ok: true };
}

export const DEFAULT_PATTERNS = {
  invoice: '{BRANCH}/INV/{FY}/{SEQ:6}',
  receipt: '{BRANCH}/RCPT/{FY}/{SEQ:6}',
  credit_note: '{BRANCH}/CN/{FY}/{SEQ:6}',
  admission: '{BRANCH}-{COURSE}-{YEAR}-{SEQ:5}',
} as const;

export type DocType = keyof typeof DEFAULT_PATTERNS;
