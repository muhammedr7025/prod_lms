import { Controller, Req } from '@nestjs/common';
import { ok, twoFactorContract } from '@exatech/contracts';
import * as s from '@exatech/db';
import { eq } from '@exatech/db';
import bwipjs from 'bwip-js';
import type { FastifyRequest } from 'fastify';
import { env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { Db } from '../db';
import { badRequest, invalid } from '../errors';
import { Allow2faPending, Endpoint, Input, type Args } from '../http';
import { RedisService } from '../redis';
import { decrypt, encrypt, generateBackupCodes, generateSecret, hashCode, otpauthUri, verifyTotp } from './totp';
import { AccessService } from './access.service';

/** TOTP two-factor: enrolment (setup → enable) and per-session verification. */
@Controller()
export class TwoFactorController {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly access: AccessService,
  ) {}

  @Endpoint(twoFactorContract.setup)
  @Allow2faPending()
  async setup(@Req() req: FastifyRequest) {
    const user = req.exa!.user;
    if (user.twoFactorEnabled) throw badRequest('Two-factor authentication is already enabled');
    const secret = generateSecret();
    await this.db.db.delete(s.twoFactor).where(eq(s.twoFactor.userId, user.id));
    await this.db.db.insert(s.twoFactor).values({ userId: user.id, secret: encrypt(secret, env().AUTH_SECRET), backupCodes: '[]' });
    const uri = otpauthUri(secret, user.email);
    const qrSvg = bwipjs.toSVG({ bcid: 'qrcode', text: uri, scale: 3, paddingwidth: 2, paddingheight: 2 });
    return { secret, uri, qrSvg };
  }

  @Endpoint(twoFactorContract.enable)
  @Allow2faPending()
  async enable(@Req() req: FastifyRequest, @Input() { body }: Args<typeof twoFactorContract.enable>) {
    const { user, session } = req.exa!;
    const [row] = await this.db.db.select().from(s.twoFactor).where(eq(s.twoFactor.userId, user.id));
    if (!row) throw badRequest('Start setup first');
    if (!verifyTotp(decrypt(row.secret, env().AUTH_SECRET), body.code)) throw invalid('That code is not valid — check the time on your phone and try again', { code: 'Invalid code' });
    const codes = generateBackupCodes();
    await this.db.tx(async (tx) => {
      await tx.update(s.twoFactor).set({ backupCodes: JSON.stringify(codes.map(hashCode)) }).where(eq(s.twoFactor.id, row.id));
      await tx.update(s.user).set({ twoFactorEnabled: true }).where(eq(s.user.id, user.id));
      await tx.update(s.session).set({ twoFactorVerified: true }).where(eq(s.session.id, session.id));
      await this.audit.log(tx, { action: '2FA enabled', kind: 'update', entityType: 'user', entityId: user.id, entityLabel: user.name });
    });
    await this.access.bump();
    return { backupCodes: codes };
  }

  @Endpoint(twoFactorContract.verify)
  @Allow2faPending()
  async verify(@Req() req: FastifyRequest, @Input() { body }: Args<typeof twoFactorContract.verify>) {
    const { user, session } = req.exa!;
    if (!(await this.redis.rateLimit(`2fa:${user.id}`, 8, 900))) throw badRequest('Too many attempts — wait 15 minutes');
    const [row] = await this.db.db.select().from(s.twoFactor).where(eq(s.twoFactor.userId, user.id));
    if (!row || !user.twoFactorEnabled) throw badRequest('Two-factor authentication is not enabled');
    const secret = decrypt(row.secret, env().AUTH_SECRET);
    let okCode = verifyTotp(secret, body.code);
    if (!okCode) {
      const hashes = JSON.parse(row.backupCodes) as string[];
      const h = hashCode(body.code);
      if (hashes.includes(h)) {
        okCode = true;
        await this.db.db.update(s.twoFactor).set({ backupCodes: JSON.stringify(hashes.filter((x) => x !== h)) }).where(eq(s.twoFactor.id, row.id));
      }
    }
    if (!okCode) throw invalid('That code is not valid', { code: 'Invalid code' });
    await this.db.db.update(s.session).set({ twoFactorVerified: true }).where(eq(s.session.id, session.id));
    return ok;
  }
}
