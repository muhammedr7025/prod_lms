import { Injectable } from '@nestjs/common';
import type { Reconciliation } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, desc, eq, gte, inArray, isNull, sql } from '@exatech/db';
import { formatDayMonth, formatINR, rupeeInputToPaise, todayIST } from '@exatech/domain';
import Papa from 'papaparse';
import { AuditService } from '../../core/audit/audit.service';
import { assertInScope, branchScope, ctx } from '../../core/context';
import { Db } from '../../core/db';
import { conflict, invalid, notFound } from '../../core/errors';
import { FilesService } from '../../core/files/files.service';
import { FinanceShared } from './finance.shared';
import { shortGatewayId, shortNumber, tail } from './ledger';
import { PaymentsService } from './payments.service';

const STATUS: Record<string, { label: string; tag: 'accent' | 'ink' | 'neutral' }> = {
  matched: { label: 'Matched', tag: 'accent' },
  unmatched: { label: 'Unmatched', tag: 'ink' },
  amount_differs: { label: 'Amount differs', tag: 'ink' },
  resolved: { label: 'Resolved', tag: 'neutral' },
};

/**
 * Settlement reconciliation: Razorpay settlement / bank CSV → items,
 * auto-matched to recorded payments by gateway payment id + amount; unmatched
 * items are recorded as an advance on a student's account or investigated.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly db: Db,
    private readonly shared: FinanceShared,
    private readonly payments: PaymentsService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {}

  async view(settlementId?: string): Promise<Reconciliation> {
    const list = await this.db.db.select().from(s.settlement).orderBy(desc(s.settlement.settledOn), desc(s.settlement.createdAt)).limit(24);
    const label = (x: typeof s.settlement.$inferSelect) => `${x.gateway === 'bank' ? 'Bank statement' : 'Razorpay settlement'} ${formatDayMonth(x.settledOn)}`;
    const current = list.find((x) => x.id === settlementId) ?? list[0] ?? null;
    const [wf] = await this.db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.webhookEvent)
      .where(and(isNull(s.webhookEvent.processedAt), sql`${s.webhookEvent.attempts} > 0`, gte(s.webhookEvent.createdAt, new Date(Date.now() - 72 * 3600_000))));
    if (!current) return { settlements: [], settlement: null, matched: 0, unmatched: 0, webhookFailures: Number(wf?.n ?? 0), items: [] };
    const items = await this.db.db.select().from(s.settlementItem).where(eq(s.settlementItem.settlementId, current.id)).orderBy(s.settlementItem.status, s.settlementItem.gatewayPaymentId);
    const pids = items.map((i) => i.matchedPaymentId).filter((x): x is string => !!x);
    const pays = pids.length
      ? await this.db.db
          .select({ id: s.payment.id, total: s.payment.total, branchId: s.payment.branchId, enrollmentId: s.payment.enrollmentId, student: s.student.name, receipt: s.receipt.number })
          .from(s.payment)
          .innerJoin(s.student, eq(s.student.id, s.payment.studentId))
          .leftJoin(s.receipt, eq(s.receipt.paymentId, s.payment.id))
          .where(inArray(s.payment.id, pids))
      : [];
    const scope = branchScope();
    const rank: Record<string, number> = { matched: 0, resolved: 1, unmatched: 2, amount_differs: 3 };
    const rows = [...items]
      .sort((a, b) => rank[a.status]! - rank[b.status]!)
      .map((i) => {
        const p = pays.find((x) => x.id === i.matchedPaymentId);
        return {
          id: i.id,
          gatewayPaymentId: shortGatewayId(i.gatewayPaymentId),
          amount: i.amount,
          notes: i.notes,
          recorded: p ? `pmt ${tail(p.id)}${p.receipt ? ` · RCPT ${shortNumber(p.receipt)}` : ''}${p.total !== i.amount ? ` · ${formatINR(p.total)}` : ''}` : null,
          recordedAmount: p?.total ?? null,
          studentName: p?.student ?? null,
          enrollmentId: p?.enrollmentId ?? null,
          status: i.status,
          statusLabel: STATUS[i.status]!.label,
          tag: STATUS[i.status]!.tag,
          resolution: i.resolution,
          _branch: p?.branchId ?? null,
        };
      })
      // Matched payments outside the selected branch stay hidden; unmatched items are everyone's to decide.
      .filter((r) => !scope || !r._branch || scope.includes(r._branch))
      .map(({ _branch, ...r }) => {
        void _branch;
        return r;
      });
    return {
      settlements: list.map((x) => ({ id: x.id, label: `${label(x)} · ${x.externalId}` })),
      settlement: { id: current.id, externalId: current.externalId, gateway: current.gateway, settledOn: current.settledOn, label: label(current), amount: current.amount, fees: current.fees, paymentCount: current.paymentCount, utr: current.utr },
      matched: items.filter((i) => i.status === 'matched').length,
      unmatched: items.filter((i) => i.status === 'unmatched' || i.status === 'amount_differs').length,
      webhookFailures: Number(wf?.n ?? 0),
      items: rows,
    };
  }

  /** CSV with payment_id, amount (₹), notes [, fee, settlement_id, settled_on]. */
  async upload(fileId: string, gateway: 'razorpay' | 'bank') {
    const f = await this.files.get(fileId);
    if (f.purpose !== 'statement') throw invalid('Upload the settlement as a CSV statement');
    const text = (await this.files.read(fileId)).toString('utf8');
    const parsed = Papa.parse<Record<string, string>>(text.trim(), { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, '_') });
    const rows = parsed.data;
    if (rows.length === 0) throw invalid('The file has no rows');
    const head = Object.keys(rows[0]!);
    const idKey = head.find((h) => ['payment_id', 'gateway_payment_id', 'entity_id', 'id', 'reference'].includes(h));
    const amtKey = head.find((h) => ['amount', 'credit', 'amount_(inr)', 'settled_amount'].includes(h));
    if (!idKey || !amtKey) throw invalid('The CSV needs payment_id and amount columns (notes optional)');
    const items: { gatewayPaymentId: string; amount: number; notes: string | null }[] = [];
    let fees = 0;
    rows.forEach((r, i) => {
      const id = (r[idKey] ?? '').trim();
      const amount = rupeeInputToPaise(r[amtKey] ?? '');
      if (!id || amount === null || amount <= 0) throw invalid(`Row ${i + 2}: needs a payment id and a positive amount`);
      items.push({ gatewayPaymentId: id, amount, notes: (r.notes ?? r.description ?? '').trim() || null });
      fees += rupeeInputToPaise(r.fee ?? r.fees ?? '0') ?? 0;
    });
    const dupes = items.filter((x, i) => items.findIndex((y) => y.gatewayPaymentId === x.gatewayPaymentId) !== i);
    if (dupes.length) throw invalid(`Payment ${dupes[0]!.gatewayPaymentId} appears twice in the file`);
    const external = (rows[0]!.settlement_id ?? '').trim() || `${gateway === 'bank' ? 'bank' : 'setl'}_${f.filename.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_').slice(0, 30)}_${Date.now().toString(36)}`;
    const settledOn = /^\d{4}-\d{2}-\d{2}$/.test((rows[0]!.settled_on ?? '').trim()) ? rows[0]!.settled_on!.trim() : todayIST();
    const id = await this.db.tx(async (tx) => {
      const [dup] = await tx.select({ id: s.settlement.id }).from(s.settlement).where(eq(s.settlement.externalId, external));
      if (dup) throw conflict(`Settlement ${external} was already uploaded`);
      const [st] = await tx
        .insert(s.settlement)
        .values({ gateway, externalId: external, settledOn, amount: items.reduce((a, x) => a + x.amount, 0), fees, paymentCount: items.length })
        .returning({ id: s.settlement.id });
      await tx.insert(s.settlementItem).values(items.map((x) => ({ settlementId: st!.id, ...x, status: 'unmatched' as const })));
      await this.audit.log(tx, { action: 'Settlement uploaded', kind: 'create', entityType: 'settlement', entityId: st!.id, entityLabel: external, summary: `${items.length} items · ${formatINR(items.reduce((a, x) => a + x.amount, 0))} · ${f.filename}` });
      return st!.id;
    });
    const m = await this.autoMatch(id);
    return { settlementId: id, items: items.length, matched: m.matched };
  }

  /** Match by gateway payment id + amount; a different amount is flagged, never auto-accepted. */
  async autoMatch(settlementId: string) {
    return this.db.tx(async (tx) => {
      const [st] = await tx.select().from(s.settlement).where(eq(s.settlement.id, settlementId)).for('update');
      if (!st) throw notFound('Settlement');
      const items = await tx.select().from(s.settlementItem).where(and(eq(s.settlementItem.settlementId, st.id), inArray(s.settlementItem.status, ['unmatched', 'amount_differs'])));
      const ids = items.map((i) => i.gatewayPaymentId);
      const pays = ids.length ? await tx.select({ id: s.payment.id, total: s.payment.total, gid: s.payment.gatewayPaymentId, status: s.payment.status }).from(s.payment).where(inArray(s.payment.gatewayPaymentId, ids)) : [];
      let matched = 0;
      let differs = 0;
      for (const i of items) {
        const p = pays.find((x) => x.gid === i.gatewayPaymentId && x.status !== 'voided');
        const status = !p ? 'unmatched' : p.total === i.amount ? 'matched' : 'amount_differs';
        if (status === 'matched') matched++;
        if (status === 'amount_differs') differs++;
        if (status !== i.status || (p?.id ?? null) !== i.matchedPaymentId) await tx.update(s.settlementItem).set({ status, matchedPaymentId: p?.id ?? null }).where(eq(s.settlementItem.id, i.id));
      }
      const [left] = await tx.select({ n: sql<number>`count(*)::int` }).from(s.settlementItem).where(and(eq(s.settlementItem.settlementId, st.id), inArray(s.settlementItem.status, ['unmatched', 'amount_differs'])));
      if (Number(left?.n ?? 0) === 0 && st.status !== 'reconciled') await tx.update(s.settlement).set({ status: 'reconciled' }).where(eq(s.settlement.id, st.id));
      await this.audit.log(tx, { action: 'Auto-match', kind: 'update', entityType: 'settlement', entityId: st.id, entityLabel: st.externalId, summary: `${matched} matched · ${differs} amount differs · ${items.length - matched - differs} unmatched` });
      this.shared.bumpDashboard(tx);
      return { matched, differs, unmatched: items.length - matched - differs };
    });
  }

  /** Unmatched gateway money → a payment (channel reconciliation) on the chosen student's account. */
  async recordAdvance(itemId: string, enrollmentId: string) {
    const c = ctx();
    return this.db.tx(async (tx) => {
      const [it] = await tx.select().from(s.settlementItem).where(eq(s.settlementItem.id, itemId)).for('update');
      if (!it) throw notFound('Settlement item');
      if (it.status !== 'unmatched') throw conflict(it.status === 'amount_differs' ? 'This payment is already recorded with a different amount — investigate it instead' : 'This item is already settled');
      const ec = await this.shared.enrollmentCtx(tx, enrollmentId);
      assertInScope(ec.branch.id);
      const res = await this.payments.record(tx, {
        enrollmentId,
        tenders: [{ method: 'online', amount: it.amount, reference: it.gatewayPaymentId }],
        channel: 'reconciliation',
        receivedBy: c.userId,
        gatewayPaymentId: it.gatewayPaymentId,
        idempotencyKey: `setl:${it.id}`,
        notes: `Recorded from settlement${it.notes ? ` · ${it.notes}` : ''}`,
      });
      await tx.update(s.settlementItem).set({ status: 'resolved', matchedPaymentId: res.paymentId, resolution: `Recorded as advance · ${ec.student.name} · ${res.receiptNumber}`, resolvedBy: c.userId, resolvedAt: new Date() }).where(eq(s.settlementItem.id, it.id));
      return { receiptNumber: res.receiptNumber, studentName: ec.student.name };
    });
  }

  async resolve(itemId: string, note: string) {
    const c = ctx();
    await this.db.tx(async (tx) => {
      const [it] = await tx.select().from(s.settlementItem).where(eq(s.settlementItem.id, itemId)).for('update');
      if (!it) throw notFound('Settlement item');
      if (it.status === 'matched' || it.status === 'resolved') throw conflict('This item needs no decision');
      await tx.update(s.settlementItem).set({ status: 'resolved', resolution: `Investigated · ${note}`, resolvedBy: c.userId, resolvedAt: new Date() }).where(eq(s.settlementItem.id, it.id));
      await this.audit.log(tx, { action: 'Settlement item resolved', kind: 'update', entityType: 'settlement', entityId: it.settlementId, entityLabel: it.gatewayPaymentId, before: { status: it.status }, after: { status: 'resolved' }, summary: `${it.gatewayPaymentId} · ${formatINR(it.amount)} · ${note}` });
      this.shared.bumpDashboard(tx);
    });
  }
}
