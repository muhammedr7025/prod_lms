import crypto from 'node:crypto';

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — what every authenticator app speaks. */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function totp(secret: string, at = Date.now(), step = 30, digits = 6): string {
  const counter = Math.floor(at / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code = ((hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).toString();
  return code.padStart(digits, '0');
}

/** Accept the current code and one step either side for clock drift. */
export function verifyTotp(secret: string, code: string, at = Date.now()): boolean {
  const c = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  return [-1, 0, 1].some((w) => crypto.timingSafeEqual(Buffer.from(totp(secret, at + w * 30_000)), Buffer.from(c)));
}

export function otpauthUri(secret: string, account: string, issuer = 'Exatech'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/* Secrets at rest: AES-256-GCM keyed from AUTH_SECRET. */
function key(secret: string) {
  return crypto.createHash('sha256').update(`totp:${secret}`).digest();
}

export function encrypt(plain: string, appSecret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(appSecret), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

export function decrypt(token: string, appSecret: string): string {
  const [iv, tag, enc] = token.split('.') as [string, string, string];
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(appSecret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64url')), decipher.final()]).toString('utf8');
}

export function generateBackupCodes(n = 8): string[] {
  return Array.from({ length: n }, () => {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code.replace(/\s+/g, '').toUpperCase()).digest('hex');
}
