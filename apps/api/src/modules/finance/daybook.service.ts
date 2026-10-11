import { Injectable } from '@nestjs/common';
import type { DayBook } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, desc, eq, gte, inArray, lt, sql } from '@exatech/db';
import { addDays, formatDayMonth, formatINR, formatLongWeekdayDate, istDateTime, monthName, monthStart, sumPaise, todayIST, toISTTime, weekday, type ISODate } from '@exatech/domain';
import { AuditService } from '../../core/audit/audit.service';
import { assertInScope, branchScope, ctx } from '../../core/context';
import { Db } from '../../core/db';
import { conflict, forbidden, invalid } from '../../core/errors';
import { FinanceShared } from './finance.shared';
import { shortNumber } from './ledger';

const DENOM_VALUE: Record<string, number> = { '500': 500_00, '200': 200_00, '100': 100_00 };

/**
 * Day book & cash closing: per counter per cashier per day (opening, collections
 * by method, deposits, closing), denomination count with difference and
 * explanation; closing the last counter locks the day for desk entries.
 * Period locks per month need a Super Admin to reopen.
 */
@Injectable()
export class DayBookService {
  constructor(
    private readonly db: Db,
    private readonly shared: FinanceShared,
    private readonly audit: AuditService,
  ) {}

  private async scopeBranches() {
    const scope = branchScope();
    const rows = await this.db.db
      .select({ id: s.branch.id, name: s.branch.name })
      .from(s.branch)
      .where(and(inArray(s.branch.status, ['active', 'paused']), scope ? inArray(s.branch.id, scope) : undefined))
      .orderBy(asc(s.branch.openedOn));
    return rows;
  }

  /** Session totals by method (non-voided, non-bounced desk payments). */
  private async sessionTotals(sessionIds: string[]) {
    if (sessionIds.length === 0) return [];
    return this.db.db
      .select({ sessionId: s.payment.cashSessionId, method: s.paymentTender.method, amount: sql<number>`sum(${s.paymentTender.amount})::bigint` })
      .from(s.paymentTender)
      .innerJoin(s.payment, eq(s.payment.id, s.paymentTender.paymentId))
      .where(and(inArray(s.payment.cashSessionId, sessionIds), inArray(s.payment.status, ['cleared', 'pending_clearance'])))
      .groupBy(s.payment.cashSessionId, s.paymentTender.method);
  }

  async dayBook(q: { date?: ISODate; branchId?: string }): Promise<DayBook> {
    const today = todayIST();
    const date = q.date ?? today;
    const branches = await this.scopeBranches();
    if (branches.length === 0) throw forbidden('No branch in scope');
    const branch = branches.find((b) => b.id === q.branchId) ?? branches[0]!;
    assertInScope(branch.id);
    const sessions = await this.db.db
      .select({ cs: s.cashSession, cashier: s.user.name })
      .from(s.cashSession)
      .innerJoin(s.user, eq(s.user.id, s.cashSession.cashierUserId))
      .where(and(eq(s.cashSession.branchId, branch.id), eq(s.cashSession.date, date)))
      .orderBy(asc(s.cashSession.counterName));
    const totals = await this.sessionTotals(sessions.map((x) => x.cs.id));
    const t = (sid: string, m: string) => Number(totals.find((x) => x.sessionId === sid && x.method === m)?.amount ?? 0);
    const counters: DayBook['counters'] = sessions.map(({ cs, cashier }) => {
      const cash = t(cs.id, 'cash');
      const closing = cs.openingCash + cash - cs.deposited;
      const open = cs.status === 'open';
      return {
        sessionId: cs.id,
        label: `${cs.counterName} · ${cashier}`,
        kind: 'counter' as const,
        opened: toISTTime(cs.openedAt),
        openingCash: cs.openingCash,
        upi: t(cs.id, 'upi'),
        cash,
        card: t(cs.id, 'card'),
        cheque: t(cs.id, 'cheque'),
        other: t(cs.id, 'transfer'),
        deposited: cs.deposited,
        depositedLabel: null,
        closingCash: open ? closing : (cs.counted ?? closing),
        statusLabel: open ? 'Open' : `Closed ${cs.closedAt ? toISTTime(cs.closedAt) : ''}`.trim(),
        tag: open ? 'outline' : 'accent',
        open,
      };
    });
    // Online · Razorpay row (gateway method kept in payment.notes as gateway:<name>:<method>).
    const from = istDateTime(date);
    const to = istDateTime(addDays(date, 1));
    const online = await this.db.db
      .select({ total: s.payment.total, notes: s.payment.notes })
      .from(s.payment)
      .where(and(eq(s.payment.branchId, branch.id), eq(s.payment.channel, 'online'), inArray(s.payment.status, ['cleared']), gte(s.payment.receivedAt, from), lt(s.payment.receivedAt, to)));
    const methodOf = (notes: string | null) => notes?.split(':')[2] || 'upi';
    const byM = (m: string) => sumPaise(online.filter((p) => methodOf(p.notes) === m).map((p) => p.total));
    const onlineOther = sumPaise(online.filter((p) => !['upi', 'card'].includes(methodOf(p.notes))).map((p) => p.total));
    counters.push({
      sessionId: null,
      label: 'Online · Razorpay',
      kind: 'online',
      opened: '—',
      openingCash: null,
      upi: byM('upi'),
      cash: null,
      card: byM('card'),
      cheque: null,
      other: onlineOther,
      deposited: null,
      depositedLabel: 'T+1 settlement',
      closingCash: null,
      statusLabel: 'Auto',
      tag: 'neutral',
      open: false,
    });

    const [dc] = await this.db.db
      .select({ closedAt: s.dayClose.closedAt, by: s.user.name })
      .from(s.dayClose)
      .leftJoin(s.user, eq(s.user.id, s.dayClose.closedBy))
      .where(and(eq(s.dayClose.branchId, branch.id), eq(s.dayClose.date, date)));
    const openCount = counters.filter((x) => x.open).length;

    // Controls.
    const locks = await this.db.db.select().from(s.periodLock).where(eq(s.periodLock.branchId, branch.id)).orderBy(desc(s.periodLock.month)).limit(3);
    const prevMonth = monthStart(addDays(monthStart(today), -1));
    const lockable = locks.some((l) => l.month === prevMonth && l.status === 'locked') ? null : { month: prevMonth, label: `${monthName(prevMonth, true)} ${prevMonth.slice(0, 4)}` };
    const voids = await this.db.db
      .select({ number: s.receipt.number, reason: s.payment.voidReason })
      .from(s.payment)
      .innerJoin(s.receipt, eq(s.receipt.paymentId, s.payment.id))
      .where(and(eq(s.payment.branchId, branch.id), eq(s.payment.status, 'voided'), gte(s.payment.voidedAt, from), lt(s.payment.voidedAt, to)));
    const cashInHand = sumPaise(counters.filter((x) => x.kind === 'counter').map((x) => x.closingCash ?? 0));
    let depositDay = addDays(date, 1);
    const holidays = new Set((await this.db.db.select({ d: s.holiday.date }).from(s.holiday).where(and(gte(s.holiday.date, date), lt(s.holiday.date, addDays(date, 10))))).map((h) => h.d));
    while (weekday(depositDay) === 0 || holidays.has(depositDay)) depositDay = addDays(depositDay, 1);
    const depositWhen = depositDay === addDays(today, 1) ? (weekday(depositDay) === 1 ? 'Monday' : 'tomorrow') : formatLongWeekdayDate(depositDay).split(' ')[0]!;

    return {
      date,
      dateLabel: `${formatLongWeekdayDate(date)} · ${branch.name}`,
      branchId: branch.id,
      branchName: branch.name,
      branches,
      dayClosed: !!dc,
      dayClosedLabel: dc ? `Closed ${toISTTime(dc.closedAt)}${dc.by ? ` · ${dc.by}` : ''}` : null,
      statusLabel: dc ? `Day closed · ${toISTTime(dc.closedAt)}` : openCount ? `${openCount} counter${openCount === 1 ? '' : 's'} open` : 'Ready to close',
      counters,
      controls: {
        periodLocks: locks.map((l) => ({
          month: l.month,
          label: `${monthName(l.month, true)}`,
          status: l.status,
          note: l.status === 'locked' ? 'Period locked · Super Admin to reopen' : `Reopened${l.reopenReason ? ` · ${l.reopenReason}` : ''}`,
        })),
        lockableMonth: lockable,
        voidsToday: voids.length ? `${voids.length} · ${voids.map((v) => `receipt ${shortNumber(v.number)}${v.reason ? ` · reason: ${v.reason}` : ''}`).join('; ')}` : 'None',
        depositDue: cashInHand > 0 ? `${formatINR(cashInHand)} cash · ${depositWhen}` : 'Nothing to deposit',
      },
    };
  }

  /**
   * Close a counter with its denomination count. Closing the last open counter
   * writes day_close — the desk refuses further entries for that branch-day.
   */
  async close(body: { branchId: string; date: ISODate; sessionId: string | null; denominations: Record<string, number>; explanation?: string }): Promise<{ dayClosed: boolean; difference: number; message: string }> {
    assertInScope(body.branchId);
    const c = ctx();
    if (body.date > todayIST()) throw invalid('You cannot close a future day');
    return this.db.tx(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`dayclose:${body.branchId}:${body.date}`}))`);
      const [already] = await tx.select({ id: s.dayClose.id }).from(s.dayClose).where(and(eq(s.dayClose.branchId, body.branchId), eq(s.dayClose.date, body.date)));
      if (already) throw conflict('This day is already closed');
      let difference = 0;
      let label = '';
      if (body.sessionId) {
        const [cs] = await tx.select().from(s.cashSession).where(eq(s.cashSession.id, body.sessionId)).for('update');
        if (!cs || cs.branchId !== body.branchId || cs.date !== body.date) throw invalid('That counter is not part of this day book');
        if (cs.status === 'closed') throw conflict(`${cs.counterName} is already closed`);
        const totals = await this.sessionTotals([cs.id]);
        const cash = Number(totals.find((x) => x.method === 'cash')?.amount ?? 0);
        const expected = cs.openingCash + cash - cs.deposited;
        const counted = Object.entries(body.denominations).reduce((a, [k, n]) => a + (k === 'coins' ? n * 100 : (DENOM_VALUE[k] ?? 0) * n), 0);
        difference = counted - expected;
        if (difference !== 0 && !(body.explanation && body.explanation.trim().length >= 5)) {
          throw invalid(`Counted ${formatINR(counted)} vs system ${formatINR(expected)} — explain the ${formatINR(Math.abs(difference))} difference before closing`, { explanation: 'Required when the count differs' });
        }
        await tx
          .update(s.cashSession)
          .set({ status: 'closed', closedAt: new Date(), closedBy: c.userId, denominations: body.denominations, counted, expectedCash: expected, difference, explanation: body.explanation?.trim() || null })
          .where(eq(s.cashSession.id, cs.id));
        label = cs.counterName;
        await this.audit.log(tx, {
          action: 'Counter closed',
          kind: 'update',
          entityType: 'cash_session',
          entityId: cs.id,
          entityLabel: `${cs.counterName} · ${body.date}`,
          before: { status: 'open' },
          after: { status: 'closed', counted, expected, difference },
          summary: `Counted ${formatINR(counted)} · system ${formatINR(expected)} · difference ${formatINR(difference)}${body.explanation ? ` · ${body.explanation}` : ''}`,
          branchId: body.branchId,
        });
      }
      const [{ open } = { open: 0 }] = await tx
        .select({ open: sql<number>`count(*)::int` })
        .from(s.cashSession)
        .where(and(eq(s.cashSession.branchId, body.branchId), eq(s.cashSession.date, body.date), eq(s.cashSession.status, 'open')));
      if (Number(open) > 0) {
        this.shared.invalidate(tx, body.branchId);
        return { dayClosed: false, difference, message: `${label} closed · ${open} other counter${Number(open) === 1 ? '' : 's'} still open — close ${Number(open) === 1 ? 'it' : 'them'} to lock the day` };
      }
      await tx.insert(s.dayClose).values({ branchId: body.branchId, date: body.date, closedBy: c.userId });
      const [b] = await tx.select({ name: s.branch.name }).from(s.branch).where(eq(s.branch.id, body.branchId));
      await this.audit.log(tx, {
        action: 'Day closed',
        kind: 'update',
        entityType: 'cash_session',
        entityLabel: `${b?.name ?? ''} · ${body.date}`,
        summary: `${formatDayMonth(body.date)} locked for desk entries${label ? ` · ${label} closed` : ''}`,
        branchId: body.branchId,
      });
      this.shared.invalidate(tx, body.branchId);
      return { dayClosed: true, difference, message: `Day closed · ${b?.name ?? ''} ${formatDayMonth(body.date)} entries locked` };
    });
  }

  async lockPeriod(branchId: string, month: ISODate): Promise<void> {
    assertInScope(branchId);
    const m = monthStart(month);
    if (m >= monthStart(todayIST())) throw invalid('Only a past month can be locked');
    await this.db.tx(async (tx) => {
      const [existing] = await tx.select().from(s.periodLock).where(and(eq(s.periodLock.branchId, branchId), eq(s.periodLock.month, m)));
      if (existing?.status === 'locked') throw conflict(`${monthName(m, true)} is already locked`);
      if (existing) await tx.update(s.periodLock).set({ status: 'locked', lockedAt: new Date(), lockedBy: ctx().userId }).where(eq(s.periodLock.id, existing.id));
      else await tx.insert(s.periodLock).values({ branchId, month: m, lockedBy: ctx().userId });
      await this.audit.log(tx, { action: 'Period locked', kind: 'update', entityType: 'cash_session', entityLabel: `${monthName(m, true)} ${m.slice(0, 4)}`, summary: `${monthName(m, true)} ${m.slice(0, 4)} locked · Super Admin to reopen`, branchId });
      this.shared.invalidate(tx, branchId);
    });
  }
}
