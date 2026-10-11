import { Injectable } from '@nestjs/common';
import type { FinanceDashboard } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from '@exatech/db';
import { addDays, ageingBucket, daysBetween, financialYear, formatDayMonth, formatLongWeekdayDate, istDateTime, monthName, monthStart, sumPaise, todayIST, toISTDate, type ISODate } from '@exatech/domain';
import { AuditService } from '../../core/audit/audit.service';
import { branchScope, ctx } from '../../core/context';
import { Db, inBranchScope } from '../../core/db';
import { invalid } from '../../core/errors';
import { RedisService } from '../../core/redis';
import { FinanceShared } from './finance.shared';
import { cgstOf, openBalance, splitGst } from './ledger';

const METHOD_ROWS: { method: string; label: string }[] = [
  { method: 'upi', label: 'UPI' },
  { method: 'cash', label: 'Cash' },
  { method: 'card', label: 'Card' },
  { method: 'cheque', label: 'Cheque' },
  { method: 'online', label: 'Online' },
  { method: 'transfer', label: 'Transfer' },
];

const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const rupees = (p: number) => (p / 100).toFixed(2);

/** Finance dashboard aggregates (cached 60 s per branch scope, bumped on money movement) and exports. */
@Injectable()
export class DashboardService {
  constructor(
    private readonly db: Db,
    private readonly shared: FinanceShared,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  async dashboard(): Promise<FinanceDashboard> {
    const scope = branchScope();
    const today = todayIST();
    const ver = await this.shared.dashboardVersion();
    const key = `fin:dash:${ver}:${today}:${scope ? [...scope].sort().join(',') : 'all'}`;
    const data = await this.redis.cached(key, 60, () => this.compute(today));
    // Approval counts are cheap and change with decisions — always live.
    const where: (SQL | undefined)[] = [eq(s.approvalRequest.status, 'pending')];
    const sc = inBranchScope(s.approvalRequest.branchId);
    if (sc) where.push(or(sc, isNull(s.approvalRequest.branchId)));
    const rows = await this.db.db.select({ kind: s.approvalRequest.kind, n: sql<number>`count(*)::int` }).from(s.approvalRequest).where(and(...where)).groupBy(s.approvalRequest.kind);
    const n = (k: string) => Number(rows.find((r) => r.kind === k)?.n ?? 0);
    return { ...data, approvals: { discounts: n('discount'), refunds: n('refund'), restructures: n('restructure'), other: n('void') + n('waiver') + n('exemption') + n('locked_period') } };
  }

  private async compute(today: ISODate): Promise<Omit<FinanceDashboard, 'approvals'> & { approvals: FinanceDashboard['approvals'] }> {
    const from = istDateTime(today);
    const to = istDateTime(addDays(today, 1));
    const payScope = inBranchScope(s.payment.branchId);

    // Collected today (cleared money) + by method.
    const todays = await this.db.db
      .select({ id: s.payment.id, total: s.payment.total, sessionId: s.payment.cashSessionId, status: s.payment.status })
      .from(s.payment)
      .where(and(payScope, gte(s.payment.receivedAt, from), lt(s.payment.receivedAt, to), inArray(s.payment.status, ['cleared', 'pending_clearance'])));
    const cleared = todays.filter((p) => p.status === 'cleared');
    const methods = todays.length
      ? await this.db.db
          .select({ method: s.paymentTender.method, amount: sql<number>`sum(${s.paymentTender.amount})::bigint` })
          .from(s.paymentTender)
          .where(inArray(s.paymentTender.paymentId, todays.map((p) => p.id)))
          .groupBy(s.paymentTender.method)
      : [];
    const max = Math.max(1, ...methods.map((m) => Number(m.amount)));
    const fin = await this.shared.settings();
    const byMethod = METHOD_ROWS.filter((m) => (m.method !== 'transfer' && fin.methods[m.method as keyof typeof fin.methods]) || Number(methods.find((x) => x.method === m.method)?.amount ?? 0) > 0).map((m) => {
      const amount = Number(methods.find((x) => x.method === m.method)?.amount ?? 0);
      return { method: m.method, label: m.label, amount, pct: Math.round((amount / max) * 100) };
    });

    // Open instalments in scope (expected this week, overdue, ageing).
    const insts = await this.db.db
      .select({ i: s.instalment })
      .from(s.instalment)
      .innerJoin(s.enrollment, eq(s.enrollment.id, s.instalment.enrollmentId))
      .where(and(inBranchScope(s.instalment.branchId), inArray(s.enrollment.status, ['active', 'on_hold']), inArray(s.instalment.status, ['due', 'partially_paid'])));
    const week = insts.filter(({ i }) => i.dueDate > today && i.dueDate <= addDays(today, 7) && openBalance(i) > 0);
    const overdue = insts.filter(({ i }) => i.dueDate < today && openBalance(i) > 0);
    const overdueStudents = new Set(overdue.map(({ i }) => i.enrollmentId));
    const promised = overdueStudents.size
      ? await this.db.db
          .selectDistinct({ e: s.duesActivity.enrollmentId })
          .from(s.duesActivity)
          .where(and(inArray(s.duesActivity.enrollmentId, [...overdueStudents]), sql`${s.duesActivity.promiseDate} >= ${today}`))
      : [];
    const buckets = ['0-30', '31-60', '61-90', '90+'] as const;
    const ageAmounts = buckets.map((b) => sumPaise(overdue.filter(({ i }) => ageingBucket(i.dueDate, today) === b).map(({ i }) => openBalance(i))));
    const ageMax = Math.max(1, ...ageAmounts);

    // Pending clearance: cheques + online orders awaiting the gateway.
    const pendingCheques = await this.db.db
      .select({ amount: s.paymentTender.amount })
      .from(s.paymentTender)
      .innerJoin(s.payment, eq(s.payment.id, s.paymentTender.paymentId))
      .where(and(payScope, eq(s.paymentTender.method, 'cheque'), eq(s.paymentTender.chequeStatus, 'pending'), inArray(s.payment.status, ['pending_clearance', 'cleared'])));
    const pendingOnline = await this.db.db
      .select({ amount: s.gatewayOrder.amount })
      .from(s.gatewayOrder)
      .innerJoin(s.enrollment, eq(s.enrollment.id, s.gatewayOrder.enrollmentId))
      .where(and(inBranchScope(s.enrollment.branchId), eq(s.gatewayOrder.status, 'created'), gte(s.gatewayOrder.createdAt, new Date(Date.now() - 24 * 3600_000))));

    // Collection vs target (this month, cleared collections).
    const mStart = monthStart(today);
    const scope = branchScope();
    const branches = await this.db.db
      .select({ id: s.branch.id, name: s.branch.name, target: s.branch.monthlyTarget })
      .from(s.branch)
      .where(and(inArray(s.branch.status, ['active', 'paused']), scope ? inArray(s.branch.id, scope) : undefined))
      .orderBy(asc(s.branch.openedOn));
    const monthly = await this.db.db
      .select({ branchId: s.payment.branchId, total: sql<number>`sum(${s.payment.total})::bigint` })
      .from(s.payment)
      .where(and(payScope, eq(s.payment.status, 'cleared'), gte(s.payment.receivedAt, istDateTime(mStart)), lt(s.payment.receivedAt, to)))
      .groupBy(s.payment.branchId);
    const rows = branches.map((b) => {
      const collected = Number(monthly.find((m) => m.branchId === b.id)?.total ?? 0);
      return { branchId: b.id, branchName: b.name, collected, target: b.target, pct: b.target > 0 ? Math.round((collected / b.target) * 100) : 0 };
    });
    const daysIn = daysBetween(mStart, today) + 1;
    const monthDays = daysBetween(mStart, monthStart(addDays(mStart, 32)));
    const totalTarget = sumPaise(rows.map((r) => r.target));
    const totalCollected = sumPaise(rows.map((r) => r.collected));
    const pace = totalTarget > 0 ? Math.round(((totalCollected / totalTarget) * 100 * monthDays) / daysIn) : 0;

    const counters = new Set(todays.map((p) => p.sessionId).filter(Boolean)).size;
    return {
      todayLabel: `${formatLongWeekdayDate(today)} · FY ${financialYear(today)}`,
      collectedToday: { amount: sumPaise(cleared.map((p) => p.total)), receipts: todays.length, counters },
      expectedWeek: { amount: sumPaise(week.map(({ i }) => openBalance(i))), instalments: week.length, rangeLabel: addDays(today, 1).slice(0, 7) === addDays(today, 7).slice(0, 7) ? `${Number(addDays(today, 1).slice(8))}–${formatDayMonth(addDays(today, 7))}` : `${formatDayMonth(addDays(today, 1))}–${formatDayMonth(addDays(today, 7))}` },
      overdue: { amount: sumPaise(overdue.map(({ i }) => openBalance(i))), students: overdueStudents.size, promised: promised.length },
      pendingClearance: { amount: sumPaise(pendingCheques.map((x) => x.amount)) + sumPaise(pendingOnline.map((x) => x.amount)), cheques: pendingCheques.length, online: pendingOnline.length },
      approvals: { discounts: 0, refunds: 0, restructures: 0, other: 0 },
      byMethod,
      ageing: buckets.map((b, i) => ({ bucket: b, label: b === '0-30' ? '0–30 d' : b === '31-60' ? '31–60' : b === '61-90' ? '61–90' : '90+', amount: ageAmounts[i]!, heightPct: Math.max(4, Math.round((ageAmounts[i]! / ageMax) * 100)) })),
      targets: {
        monthLabel: monthName(today, true),
        rows,
        paceNote: `${daysIn} day${daysIn === 1 ? '' : 's'} in · pace suggests ${pace}% by month end`,
      },
      refreshedAt: new Date().toISOString(),
    };
  }

  private monthRange(month?: string): { start: ISODate; end: ISODate; label: string } {
    const m = month ?? todayIST().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m)) throw invalid('Pick a month (YYYY-MM)');
    const start = `${m}-01`;
    const end = monthStart(addDays(start, 32));
    return { start, end, label: `${monthName(start, true)} ${m.slice(0, 4)}` };
  }

  /** GST summary (CSV): per invoice + per SAC totals, CGST/SGST split; credit notes negative. */
  async gstCsv(month?: string): Promise<{ csv: string; filename: string }> {
    const { start, end, label } = this.monthRange(month);
    const invs = await this.db.db
      .select({ inv: s.invoice, student: s.student.name, branch: s.branch.code })
      .from(s.invoice)
      .innerJoin(s.student, eq(s.student.id, s.invoice.studentId))
      .innerJoin(s.branch, eq(s.branch.id, s.invoice.branchId))
      .where(and(inBranchScope(s.invoice.branchId), gte(s.invoice.issueDate, start), lt(s.invoice.issueDate, end)))
      .orderBy(asc(s.invoice.issueDate), asc(s.invoice.number));
    const cns = await this.db.db
      .select({ cn: s.creditNote, inv: s.invoice, student: s.student.name, branch: s.branch.code })
      .from(s.creditNote)
      .innerJoin(s.enrollment, eq(s.enrollment.id, s.creditNote.enrollmentId))
      .innerJoin(s.student, eq(s.student.id, s.enrollment.studentId))
      .innerJoin(s.branch, eq(s.branch.id, s.creditNote.branchId))
      .leftJoin(s.invoice, eq(s.invoice.id, s.creditNote.invoiceId))
      .where(and(inBranchScope(s.creditNote.branchId), gte(s.creditNote.createdAt, istDateTime(start)), lt(s.creditNote.createdAt, istDateTime(end))));
    const lines: string[] = [['document', 'number', 'date', 'branch', 'student', 'sac', 'gst_rate', 'taxable', 'cgst', 'sgst', 'total', 'status'].join(',')];
    const bySac = new Map<string, { taxable: number; cgst: number; sgst: number; total: number }>();
    const add = (sac: string, taxable: number, cgst: number, sgst: number, total: number) => {
      const r = bySac.get(sac) ?? { taxable: 0, cgst: 0, sgst: 0, total: 0 };
      bySac.set(sac, { taxable: r.taxable + taxable, cgst: r.cgst + cgst, sgst: r.sgst + sgst, total: r.total + total });
    };
    for (const { inv, student, branch } of invs) {
      for (const l of inv.lines) {
        const cgst = cgstOf(l.tax);
        const sgst = l.tax - cgst;
        lines.push(['Tax invoice', inv.number, inv.issueDate, branch, student, l.sac, l.taxRate, rupees(l.amount), rupees(cgst), rupees(sgst), rupees(l.amount + l.tax), inv.status].map(esc).join(','));
        add(l.sac, l.amount, cgst, sgst, l.amount + l.tax);
      }
    }
    for (const { cn, inv, student, branch } of cns) {
      const rate = inv?.lines[0]?.taxRate ?? 18;
      const sac = inv?.lines[0]?.sac ?? (await this.shared.settings()).sac;
      const g = splitGst(cn.amount, rate);
      lines.push(['Credit note', cn.number, toISTDate(cn.createdAt), branch, student, sac, rate, rupees(-g.taxable), rupees(-g.cgst), rupees(-g.sgst), rupees(-cn.amount), cn.reason].map(esc).join(','));
      add(sac, -g.taxable, -g.cgst, -g.sgst, -cn.amount);
    }
    lines.push('', ['summary_by_sac', 'sac', 'taxable', 'cgst', 'sgst', 'total'].join(','));
    for (const [sac, t] of bySac) lines.push(['Total', sac, rupees(t.taxable), rupees(t.cgst), rupees(t.sgst), rupees(t.total)].map(esc).join(','));
    const c = ctx();
    lines.unshift(`# GST summary · ${label} · exported by ${c.userName} (${c.roleLabel}) at ${new Date().toISOString()} — confidential`);
    await this.audit.log(this.db.db, { action: 'Export', kind: 'export', entityType: 'report', entityLabel: 'gst-summary', summary: `GST summary ${label} · ${invs.length} invoices · ${cns.length} credit notes` });
    return { csv: lines.join('\n'), filename: `gst-summary-${start.slice(0, 7)}.csv` };
  }

  /** Tally vouchers (CSV): Sales vouchers for invoices, Receipt vouchers for payments, Credit Notes. */
  async tallyCsv(month?: string): Promise<{ csv: string; filename: string }> {
    const { start, end, label } = this.monthRange(month);
    const invs = await this.db.db
      .select({ inv: s.invoice, student: s.student.name, adm: s.student.admissionNo })
      .from(s.invoice)
      .innerJoin(s.student, eq(s.student.id, s.invoice.studentId))
      .where(and(inBranchScope(s.invoice.branchId), gte(s.invoice.issueDate, start), lt(s.invoice.issueDate, end)))
      .orderBy(asc(s.invoice.issueDate));
    const pays = await this.db.db
      .select({ p: s.payment, r: s.receipt, student: s.student.name, adm: s.student.admissionNo })
      .from(s.payment)
      .innerJoin(s.receipt, eq(s.receipt.paymentId, s.payment.id))
      .innerJoin(s.student, eq(s.student.id, s.payment.studentId))
      .where(and(inBranchScope(s.payment.branchId), gte(s.payment.receivedAt, istDateTime(start)), lt(s.payment.receivedAt, istDateTime(end))))
      .orderBy(asc(s.payment.receivedAt));
    const tenders = pays.length ? await this.db.db.select().from(s.paymentTender).where(inArray(s.paymentTender.paymentId, pays.map((x) => x.p.id))) : [];
    const ledgerFor = (m: string) => (m === 'cash' ? 'Cash' : m === 'online' ? 'Razorpay Clearing' : m === 'cheque' ? 'Cheques in Hand' : 'Bank');
    const out: string[] = [['date', 'voucher_type', 'voucher_no', 'party_ledger', 'ledger', 'debit', 'credit', 'narration'].join(',')];
    for (const { inv, student, adm } of invs) {
      const party = `${student} (${adm ?? '—'})`;
      const date = inv.issueDate.split('-').reverse().join('-');
      out.push([date, 'Sales', inv.number, party, party, rupees(inv.total), '', `Fee invoice${inv.status === 'cancelled' ? ' (cancelled)' : ''}`].map(esc).join(','));
      out.push([date, 'Sales', inv.number, party, 'Course Fees', '', rupees(inv.subtotal), ''].map(esc).join(','));
      out.push([date, 'Sales', inv.number, party, 'Output CGST', '', rupees(cgstOf(inv.tax)), ''].map(esc).join(','));
      out.push([date, 'Sales', inv.number, party, 'Output SGST', '', rupees(inv.tax - cgstOf(inv.tax)), ''].map(esc).join(','));
    }
    for (const { p, r, student, adm } of pays) {
      const party = `${student} (${adm ?? '—'})`;
      const date = toISTDate(p.receivedAt).split('-').reverse().join('-');
      for (const t of tenders.filter((x) => x.paymentId === p.id)) out.push([date, 'Receipt', r.number, party, ledgerFor(t.method), rupees(t.amount), '', `${t.method}${t.reference ? ` ${t.reference}` : ''}${p.status === 'voided' ? ' (voided)' : ''}`].map(esc).join(','));
      out.push([date, 'Receipt', r.number, party, party, '', rupees(p.total), p.status === 'voided' ? `voided · ${p.voidReason ?? ''}` : ''].map(esc).join(','));
    }
    const c = ctx();
    out.unshift(`# Tally vouchers · ${label} · exported by ${c.userName} at ${new Date().toISOString()} — confidential`);
    await this.audit.log(this.db.db, { action: 'Export', kind: 'export', entityType: 'report', entityLabel: 'tally', summary: `Tally vouchers ${label} · ${invs.length} invoices · ${pays.length} receipts` });
    return { csv: out.join('\n'), filename: `tally-vouchers-${start.slice(0, 7)}.csv` };
  }

}
