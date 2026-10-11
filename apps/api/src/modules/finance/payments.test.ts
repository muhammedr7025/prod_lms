import * as s from '@exatech/db';
import { and, asc, createDb, eq, sql, type DbHandle, type Tx } from '@exatech/db';
import { todayIST } from '@exatech/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../core/audit/audit.service';
import { Db } from '../../core/db';
import { EventBus } from '../../core/events/event-bus';
import type { NotifyService } from '../../core/notifications/notify.service';
import { NumberingService } from '../../core/numbering.service';
import type { RedisService } from '../../core/redis';
import { FinanceShared } from './finance.shared';
import { InvoicesService } from './invoices.service';
import { instalmentState, instalmentStatus, lateFeeDue, openBalance, planAllocation, splitGst, type InstalmentLike } from './ledger';
import { PaymentsService } from './payments.service';

const inst = (o: Partial<InstalmentLike> & Pick<InstalmentLike, 'id' | 'dueDate' | 'amount'>): InstalmentLike => ({ seq: 1, label: o.id, paid: 0, pendingPaid: 0, waived: 0, lateFee: 0, status: 'due', ...o });

/* ───────────────────────── Pure allocation / clearance arithmetic ───────────────────────── */

describe('planAllocation', () => {
  const a = inst({ id: 'a', seq: 1, dueDate: '2026-08-01', amount: 28_800_00, paid: 28_800_00, status: 'paid' });
  const b = inst({ id: 'b', seq: 2, dueDate: '2026-10-01', amount: 21_600_00, paid: 6_600_00, status: 'partially_paid' });
  const c = inst({ id: 'c', seq: 3, dueDate: '2026-12-01', amount: 21_600_00 });

  it('allocates oldest due first and holds the excess as credit', () => {
    const p = planAllocation([{ method: 'upi', amount: 40_000_00, reference: 'X' }], [c, b, a], 'oldest_first');
    expect(p.outstanding).toBe(36_600_00);
    expect(p.allocations).toEqual([
      { instalmentId: 'b', amount: 15_000_00, pending: false },
      { instalmentId: 'c', amount: 21_600_00, pending: false },
    ]);
    expect(p.excess).toBe(3_400_00);
  });

  it('allocates cleared money before cheque money (cheques are pending)', () => {
    const p = planAllocation(
      [
        { method: 'cheque', amount: 20_000_00, reference: '123456' },
        { method: 'cash', amount: 10_000_00 },
      ],
      [b, c],
      'oldest_first',
    );
    expect(p.pendingTotal).toBe(20_000_00);
    expect(p.allocations).toEqual([
      { instalmentId: 'b', amount: 10_000_00, pending: false },
      { instalmentId: 'b', amount: 5_000_00, pending: true },
      { instalmentId: 'c', amount: 15_000_00, pending: true },
    ]);
    expect(p.excess).toBe(0);
  });

  it('includes posted late fees in the open balance (principal first within an instalment)', () => {
    const late = inst({ id: 'l', dueDate: '2026-09-01', amount: 15_000_00, lateFee: 500_00 });
    expect(openBalance(late)).toBe(15_500_00);
    const p = planAllocation([{ method: 'cash', amount: 15_000_00 }], [late], 'oldest_first');
    expect(p.allocations).toEqual([{ instalmentId: 'l', amount: 15_000_00, pending: false }]);
    // Principal is covered → clearance counts it as paid, the late fee stays open.
    expect(instalmentStatus({ ...late, paid: 15_000_00 })).toBe('partially_paid');
    expect(openBalance({ ...late, paid: 15_000_00 })).toBe(500_00);
  });

  it('labels instalment states for the desk', () => {
    expect(instalmentState(b, '2026-10-11')).toEqual({ state: 'overdue', label: 'Overdue 10 days', tag: 'ink' });
    expect(instalmentState(c, '2026-10-11').label).toBe('Not due');
    expect(instalmentState(a, '2026-10-11').label).toBe('Paid');
    expect(instalmentState({ ...c, pendingPaid: 21_600_00 }, '2026-10-11').label).toBe('Pending clearance');
  });

  it('accrues late fee after grace on the unpaid balance only, capped', () => {
    const rule = { graceDays: 3, perDay: 100_00, capPct: 5 };
    expect(lateFeeDue(b, '2026-10-04', rule)).toBe(0);
    expect(lateFeeDue(b, '2026-10-11', rule)).toBe(700_00);
    expect(lateFeeDue(b, '2026-12-31', rule)).toBe(1_080_00); // 5 % of ₹21,600
    expect(lateFeeDue({ ...b, paid: 21_600_00 }, '2026-12-31', rule)).toBe(0);
  });

  it('splits GST-inclusive amounts into taxable + CGST/SGST in whole rupees', () => {
    const g = splitGst(15_000_00, 18);
    expect(g.taxable + g.tax).toBe(15_000_00);
    expect(g.taxable % 100).toBe(0);
    expect(g.cgst + g.sgst).toBe(g.tax);
  });
});

/* ───────────────────────── PaymentsService.record against the real DB (rolled back) ───────────────────────── */

const url = process.env.DATABASE_URL;

class Rollback extends Error {}

describe.skipIf(!url)('PaymentsService.record (real DB, every test rolled back)', () => {
  let handle: DbHandle;
  let payments: PaymentsService;
  let shared: FinanceShared;

  beforeAll(() => {
    handle = createDb(url, { max: 2 });
    const db = new Db(handle);
    const redis = { client: { incr: async () => 1, get: async () => null }, key: (...p: string[]) => p.join(':') } as unknown as RedisService;
    const notify = { invalidate: () => undefined, invalidateUsers: () => undefined, notify: async () => undefined } as unknown as NotifyService;
    const events = new EventBus();
    const audit = new AuditService();
    shared = new FinanceShared(db, new NumberingService(), events, notify, redis);
    payments = new PaymentsService(shared, new InvoicesService(shared, events, audit), events, audit);
  });
  afterAll(async () => {
    await handle?.close();
  });

  /** Run `fn` in a transaction that is always rolled back. */
  async function inTx(fn: (tx: Tx) => Promise<void>) {
    await handle.db
      .transaction(async (tx) => {
        await fn(tx);
        throw new Rollback();
      })
      .catch((e) => {
        if (!(e instanceof Rollback)) throw e;
      });
  }

  /** A locked enrollment with an overdue open instalment (seed: Anjali, Rohan, …) in a branch without a closed day. */
  async function lockedEnrollment(tx: Tx) {
    const today = todayIST();
    const rows = await tx.execute<{ id: string }>(sql`
      select e.id from enrollment e
      where e.status = 'active' and e.fee_cleared = false
        and exists (select 1 from instalment i where i.enrollment_id = e.id and i.status in ('due','partially_paid') and i.due_date < ${today}
                    and i.amount - i.waived - i.paid - i.pending_paid > 0)
        and not exists (select 1 from day_close d where d.branch_id = e.branch_id and d.date = ${today})
      order by e.id limit 1`);
    expect(rows.length, 'seeded locked enrollment').toBe(1);
    return rows[0]!.id;
  }

  it('allocates oldest-due-first, issues the next gap-free receipt, ledgers it and unlocks clearance', async () => {
    await inTx(async (tx) => {
      const enrollmentId = await lockedEnrollment(tx);
      const insts = await tx.select().from(s.instalment).where(eq(s.instalment.enrollmentId, enrollmentId)).orderBy(asc(s.instalment.dueDate));
      const overdue = insts.filter((i) => i.dueDate < todayIST() && openBalance(i) > 0);
      const due = overdue.reduce((a, i) => a + openBalance(i), 0);
      const [enr] = await tx.select().from(s.enrollment).where(eq(s.enrollment.id, enrollmentId));
      const [seqRow] = await tx.execute<{ next_seq: number }>(sql`select next_seq from doc_sequence where scope_id = ${enr!.branchId} and doc_type = 'receipt' order by period desc limit 1`);

      const r = await payments.record(tx, { enrollmentId, tenders: [{ method: 'upi', amount: due, reference: 'UT-1' }], channel: 'desk', receivedBy: null, idempotencyKey: 'unit-1' });
      expect(r.replay).toBe(false);
      expect(r.status).toBe('cleared');
      expect(r.total).toBe(due);
      expect(Number(/(\d+)$/.exec(r.receiptNumber)![1])).toBe(Number(seqRow!.next_seq));
      expect(r.feeCleared).toBe(true);

      const after = await tx.select().from(s.instalment).where(eq(s.instalment.enrollmentId, enrollmentId));
      for (const o of overdue) expect(openBalance(after.find((x) => x.id === o.id)!)).toBe(0);
      const ledger = await tx.select().from(s.ledgerEntry).where(and(eq(s.ledgerEntry.paymentId, r.paymentId), eq(s.ledgerEntry.kind, 'payment')));
      expect(ledger[0]?.credit).toBe(due);
      const [e2] = await tx.select().from(s.enrollment).where(eq(s.enrollment.id, enrollmentId));
      expect(e2!.feeCleared).toBe(true);
      const outbox = await tx.select({ type: s.outboxEvent.type }).from(s.outboxEvent).where(sql`${s.outboxEvent.payload}->>'enrollmentId' = ${enrollmentId}`);
      expect(outbox.map((o) => o.type)).toEqual(expect.arrayContaining(['PaymentRecorded', 'ReceiptIssued', 'FeeClearanceChanged']));
    });
  });

  it('is idempotent: a replay with the same key returns the same receipt and records nothing new', async () => {
    await inTx(async (tx) => {
      const enrollmentId = await lockedEnrollment(tx);
      const input = { enrollmentId, tenders: [{ method: 'cash' as const, amount: 2_000_00 }], channel: 'desk' as const, receivedBy: null, idempotencyKey: 'unit-replay' };
      const first = await payments.record(tx, input);
      const again = await payments.record(tx, input);
      expect(again.replay).toBe(true);
      expect(again.receiptId).toBe(first.receiptId);
      const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.payment).where(eq(s.payment.idempotencyKey, 'unit-replay'));
      expect(Number(n)).toBe(1);
      // Gateway retries are matched on the gateway payment id too.
      const online = { enrollmentId, tenders: [{ method: 'online' as const, amount: 1_500_00, reference: 'pay_unit' }], channel: 'online' as const, receivedBy: null, gatewayPaymentId: 'pay_unit', idempotencyKey: 'gw:pay_unit' };
      const o1 = await payments.record(tx, online);
      const o2 = await payments.record(tx, { ...online, idempotencyKey: 'gw:pay_unit:retry' });
      expect(o2.paymentId).toBe(o1.paymentId);
    });
  });

  it('refuses a partial payment below the minimum and a UPI payment without a reference', async () => {
    await inTx(async (tx) => {
      const enrollmentId = await lockedEnrollment(tx);
      await expect(payments.record(tx, { enrollmentId, tenders: [{ method: 'cash', amount: 500_00 }], channel: 'desk', receivedBy: null, idempotencyKey: 'unit-min' })).rejects.toThrow('Minimum partial payment is ₹1,000');
    });
    await inTx(async (tx) => {
      const enrollmentId = await lockedEnrollment(tx);
      await expect(payments.record(tx, { enrollmentId, tenders: [{ method: 'upi', amount: 5_000_00 }], channel: 'desk', receivedBy: null, idempotencyKey: 'unit-ref' })).rejects.toThrow('UPI transaction ID is required');
    });
  });

  it('keeps cheque money pending: no clearance until the cheque clears', async () => {
    await inTx(async (tx) => {
      const enrollmentId = await lockedEnrollment(tx);
      const insts = await shared.instalments(tx, enrollmentId);
      const due = insts.filter((i) => i.dueDate < todayIST()).reduce((a, i) => a + openBalance(i), 0);
      const r = await payments.record(tx, { enrollmentId, tenders: [{ method: 'cheque', amount: due, reference: '000123' }], channel: 'desk', receivedBy: null, idempotencyKey: 'unit-cheque' });
      expect(r.status).toBe('pending_clearance');
      expect(r.feeCleared).toBe(false);
      const pending = await tx.select().from(s.paymentAllocation).where(eq(s.paymentAllocation.paymentId, r.paymentId));
      expect(pending.every((p) => p.pending)).toBe(true);
      await payments.chequeOutcome(tx, r.paymentId, 'cleared');
      const [e] = await tx.select({ feeCleared: s.enrollment.feeCleared }).from(s.enrollment).where(eq(s.enrollment.id, enrollmentId));
      expect(e!.feeCleared).toBe(true);
    });
  });

  it('voids by reversal: allocations reversed, ledger reversal appended, clearance recomputed', async () => {
    await inTx(async (tx) => {
      const enrollmentId = await lockedEnrollment(tx);
      const insts = await shared.instalments(tx, enrollmentId);
      const due = insts.filter((i) => i.dueDate < todayIST()).reduce((a, i) => a + openBalance(i), 0);
      const r = await payments.record(tx, { enrollmentId, tenders: [{ method: 'cash', amount: due }], channel: 'desk', receivedBy: null, idempotencyKey: 'unit-void' });
      expect(r.feeCleared).toBe(true);
      await payments.voidPayment(tx, r.paymentId, 'Unit test reversal');
      const [p] = await tx.select().from(s.payment).where(eq(s.payment.id, r.paymentId));
      expect(p!.status).toBe('voided');
      const rev = await tx.select().from(s.ledgerEntry).where(and(eq(s.ledgerEntry.paymentId, r.paymentId), eq(s.ledgerEntry.kind, 'reversal')));
      expect(rev[0]?.debit).toBe(due);
      const [e] = await tx.select({ feeCleared: s.enrollment.feeCleared }).from(s.enrollment).where(eq(s.enrollment.id, enrollmentId));
      expect(e!.feeCleared).toBe(false);
    });
  });
});
