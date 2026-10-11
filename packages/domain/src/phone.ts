/**
 * Phone numbers are stored in E.164. Indian mobiles are the default:
 * "9847011223", "098470 11223", "+91 98470-11223" → "+919847011223".
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = input.trim();
  const digits = raw.replace(/[^\d]/g, '');
  if (raw.startsWith('+')) {
    if (digits.startsWith('91')) return isIndianMobile(digits.slice(2)) ? `+${digits}` : null;
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  let local = digits;
  if (local.length === 12 && local.startsWith('91')) local = local.slice(2);
  if (local.length === 11 && local.startsWith('0')) local = local.slice(1);
  return isIndianMobile(local) ? `+91${local}` : null;
}

function isIndianMobile(tenDigits: string): boolean {
  return /^[6-9]\d{9}$/.test(tenDigits);
}

export function isValidPhone(input: string | null | undefined): boolean {
  return normalizePhone(input) !== null;
}

/** "+919847011210" → "98•••••210" (PII masked in lists and logs). */
export function maskPhone(e164: string | null | undefined): string {
  if (!e164) return '—';
  const local = e164.startsWith('+91') ? e164.slice(3) : e164.replace(/^\+/, '');
  if (local.length < 6) return '•••';
  return `${local.slice(0, 2)}${'•'.repeat(local.length - 5)}${local.slice(-3)}`;
}

/** "+919847011223" → "+91 98470 11223" */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '—';
  if (e164.startsWith('+91') && e164.length === 13) {
    const l = e164.slice(3);
    return `+91 ${l.slice(0, 5)} ${l.slice(5)}`;
  }
  return e164;
}

export function maskEmail(email: string | null | undefined): string {
  if (!email) return '—';
  const [user, domain] = email.split('@');
  if (!user || !domain) return '•••';
  return `${user.slice(0, 2)}•••@${domain}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function isValidEmail(email: string | null | undefined): boolean {
  return !!email && EMAIL_RE.test(email.trim());
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const e = email.trim().toLowerCase();
  return isValidEmail(e) ? e : null;
}
