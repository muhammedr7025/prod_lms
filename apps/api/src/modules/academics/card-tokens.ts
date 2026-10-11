import { Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import { env } from '../../config/env';

const PREFIX = 'EXA1';

/**
 * Signed QR payload printed on ID cards: "EXA1.<cardToken>.<hmac>" where
 * hmac = HMAC-SHA256(AUTH_SECRET, cardToken). Reissuing a card rotates the
 * token, so an old card's QR stops resolving.
 */
@Injectable()
export class CardTokens {
  private sign(token: string): string {
    return crypto.createHmac('sha256', env().AUTH_SECRET).update(token).digest('base64url').slice(0, 32);
  }

  payload(cardToken: string): string {
    return `${PREFIX}.${cardToken}.${this.sign(cardToken)}`;
  }

  /**
   * undefined = not a card payload (treat as a normal search);
   * null = looks like a card but the signature is wrong;
   * string = the verified card token.
   */
  resolve(text: string): string | null | undefined {
    const t = text.trim();
    if (!t.startsWith(`${PREFIX}.`)) return undefined;
    const parts = t.split('.');
    if (parts.length !== 3) return null;
    const [, token, sig] = parts as [string, string, string];
    const expected = this.sign(token);
    if (sig.length !== expected.length) return null;
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? token : null;
  }
}
