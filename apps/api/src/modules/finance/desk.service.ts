import { Injectable } from '@nestjs/common';
import type { DeskMatch } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, eq, ilike, inArray, or, sql, type SQL } from '@exatech/db';
import { maskPhone, todayIST } from '@exatech/domain';
import bwipjs from 'bwip-js';
import { branchScope, ctx } from '../../core/context';
import { Db, inBranchScope } from '../../core/db';
import { conflict, invalid } from '../../core/errors';
import { CardTokens } from '../academics/card-tokens';
import { FinanceShared } from './finance.shared';
import { PaymentsService } from './payments.service';
import type { TenderLine } from '@exatech/domain';

const COUNTERS = ['Counter 1', 'Counter 2', 'Counter 3'];

/**
 * Collection desk: scan or search, open the fee account, collect. The first
 * desk payment of the day opens a cash session for the cashier's counter.
 */
@Injectable()
export class DeskService {
  constructor(
    private readonly db: Db,
    private readonly shared: FinanceShared,
    private readonly payments: PaymentsService,
    private readonly cards: CardTokens,
  ) {}

  /** Name / phone / admission no / barcode (Code 128 = admission no) / signed card QR. */
  async search(q: { q?: string; studentId?: string }): Promise<{ items: DeskMatch[]; cardRejected: boolean }> {
    const base = and(inArray(s.enrollment.status, ['active', 'on_hold']), inBranchScope(s.enrollment.branchId));
    const select = () =>
      this.db.db
        .select({ studentId: s.student.id, enrollmentId: s.enrollment.id, name: s.student.name, admissionNo: s.student.admissionNo, phone: s.student.phone, batchCode: s.batch.code, branchName: s.branch.name })
        .from(s.student)
        .innerJoin(s.enrollment, eq(s.enrollment.studentId, s.student.id))
        .innerJoin(s.batch, eq(s.batch.id, s.enrollment.batchId))
        .innerJoin(s.branch, eq(s.branch.id, s.enrollment.branchId));
    const shape = (rows: Awaited<ReturnType<typeof select>>, matchedBy: DeskMatch['matchedBy'], exact: (r: (typeof rows)[number]) => boolean): DeskMatch[] =>
      rows.map((r) => ({ studentId: r.studentId, enrollmentId: r.enrollmentId, name: r.name, admissionNo: r.admissionNo, batchCode: r.batchCode, branchName: r.branchName, phoneMasked: maskPhone(r.phone), matchedBy, exact: exact(r) }));

    if (q.studentId) {
      const rows = await select().where(and(base, eq(s.student.id, q.studentId)));
      return { items: shape(rows, 'student', () => true), cardRejected: false };
    }
    const text = (q.q ?? '').trim();
    if (text.length < 2) return { items: [], cardRejected: false };

    const card = this.cards.resolve(text);
    if (card === null) return { items: [], cardRejected: true };
    if (card) {
      const rows = await select().where(and(base, eq(s.student.cardToken, card)));
      return { items: shape(rows, 'card', () => true), cardRejected: false };
    }
    // Admission number (scanner input is the Code 128 text).
    const adm = text.toUpperCase();
    const exactAdm = await select().where(and(base, eq(sql`upper(${s.student.admissionNo})`, adm)));
    if (exactAdm.length) return { items: shape(exactAdm, 'admission_no', () => true), cardRejected: false };

    const digits = text.replace(/\D/g, '');
    const conds: SQL[] = [ilike(s.student.name, `%${text.replace(/[%_]/g, '')}%`), ilike(s.student.admissionNo, `%${text.replace(/[%_]/g, '')}%`)];
    if (digits.length >= 4) conds.push(ilike(s.student.phone, `%${digits}%`));
    const rows = await select()
      .where(and(base, or(...conds)))
      .orderBy(sql`case when ${s.student.name} ilike ${`${text}%`} then 0 else 1 end`, asc(s.student.name))
      .limit(12);
    const lower = text.toLowerCase();
    return {
      items: shape(rows, digits.length >= 4 && !/[a-z]/i.test(text) ? 'phone' : 'name', (r) => r.name.toLowerCase() === lower || (!!digits && digits.length >= 10 && (r.phone ?? '').endsWith(digits.slice(-10)))),
      cardRejected: false,
    };
  }

  async session(counter: string) {
    const c = ctx();
    const today = todayIST();
    const scope = branchScope();
    const sessions = await this.db.db
      .select({ cs: s.cashSession, branchName: s.branch.name, cashier: s.user.name })
      .from(s.cashSession)
      .innerJoin(s.branch, eq(s.branch.id, s.cashSession.branchId))
      .innerJoin(s.user, eq(s.user.id, s.cashSession.cashierUserId))
      .where(and(eq(s.cashSession.date, today), eq(s.cashSession.counterName, counter), scope ? inArray(s.cashSession.branchId, scope) : undefined));
    const names = await this.db.db
      .selectDistinct({ name: s.cashSession.counterName })
      .from(s.cashSession)
      .where(scope ? inArray(s.cashSession.branchId, scope) : undefined);
    const closed = await this.db.db
      .select({ branchId: s.dayClose.branchId })
      .from(s.dayClose)
      .where(and(eq(s.dayClose.date, today), scope ? inArray(s.dayClose.branchId, scope) : undefined));
    return {
      counters: [...new Set([...COUNTERS, ...names.map((n) => n.name)])].sort(),
      sessions: sessions.map((r) => ({
        id: r.cs.id,
        branchId: r.cs.branchId,
        branchName: r.branchName,
        counterName: r.cs.counterName,
        cashierName: r.cashier,
        cashierIsMe: r.cs.cashierUserId === c.userId,
        openedAt: r.cs.openedAt,
        status: r.cs.status,
        closedAt: r.cs.closedAt,
      })),
      dayClosedBranches: closed.map((d) => d.branchId),
    };
  }

  /** Desk collection: find-or-open the cash session, then the shared payment path. */
  async collect(body: { enrollmentId: string; tenders: TenderLine[]; counterName: string; idempotencyKey: string }) {
    const c = ctx();
    const today = todayIST();
    const run = () =>
      this.db.tx(async (tx) => {
        const ec = await this.shared.enrollmentCtx(tx, body.enrollmentId);
        const scope = branchScope();
        if (scope && !scope.includes(ec.branch.id)) throw invalid(`${ec.student.name} belongs to ${ec.branch.name}, outside the selected branch`);
        // Replays return the original receipt before any session checks.
        const [prior] = await tx.select({ id: s.payment.id }).from(s.payment).where(eq(s.payment.idempotencyKey, body.idempotencyKey));
        if (prior) return this.payments.result(tx, prior.id, true);
        await this.shared.assertOpenPeriod(tx, ec.branch.id, today, { dayClose: true });
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cash:${ec.branch.id}:${body.counterName}:${today}`}))`);
        let [sess] = await tx
          .select()
          .from(s.cashSession)
          .where(and(eq(s.cashSession.branchId, ec.branch.id), eq(s.cashSession.counterName, body.counterName), eq(s.cashSession.date, today)));
        if (sess && sess.status === 'closed') throw invalid(`${body.counterName} was closed for today — choose another counter`);
        if (sess && sess.cashierUserId !== c.userId) {
          const [u] = await tx.select({ name: s.user.name }).from(s.user).where(eq(s.user.id, sess.cashierUserId));
          throw conflict(`${body.counterName} is open under ${u?.name ?? 'another cashier'} today — choose another counter`);
        }
        if (!sess) {
          [sess] = await tx.insert(s.cashSession).values({ branchId: ec.branch.id, counterName: body.counterName, cashierUserId: c.userId, date: today }).returning();
        }
        return this.payments.record(tx, {
          enrollmentId: body.enrollmentId,
          tenders: body.tenders,
          channel: 'desk',
          receivedBy: c.userId,
          cashSessionId: sess!.id,
          idempotencyKey: body.idempotencyKey,
          today,
        });
      });
    try {
      return await run();
    } catch (err) {
      // A concurrent duplicate (same idempotency key) loses the unique race: answer with the winner.
      const cause = (err as { cause?: { code?: string } }).cause ?? (err as { code?: string });
      if (cause?.code === '23505') {
        const [p] = await this.db.db.select({ id: s.payment.id }).from(s.payment).where(eq(s.payment.idempotencyKey, body.idempotencyKey));
        if (p) return this.db.tx((tx) => this.payments.result(tx, p.id, true));
      }
      throw err;
    }
  }

  async upiQr(enrollmentId: string, amount: number): Promise<Buffer> {
    const fin = await this.shared.settings();
    if (!fin.upiVpa) throw invalid('Add the UPI VPA in Finance settings to show a QR');
    if (!Number.isInteger(amount) || amount <= 0) throw invalid('Enter the amount first');
    const c = await this.shared.enrollmentCtx(this.db.db, enrollmentId);
    const inst = await this.shared.institution();
    const url = `upi://pay?pa=${encodeURIComponent(fin.upiVpa)}&pn=${encodeURIComponent(inst.name)}&am=${(amount / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent(c.student.admissionNo ?? c.student.name)}`;
    return bwipjs.toBuffer({ bcid: 'qrcode', text: url, scale: 5, paddingwidth: 2, paddingheight: 2 });
  }

  async barcode(text: string): Promise<Buffer> {
    if (!/^[\w\-/]{3,40}$/.test(text)) throw invalid('Not a printable admission number');
    return bwipjs.toBuffer({ bcid: 'code128', text, scale: 2, height: 9, includetext: false });
  }
}
