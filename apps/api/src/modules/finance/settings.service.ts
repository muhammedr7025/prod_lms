import { Injectable } from '@nestjs/common';
import type { FinanceSettingsView } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, desc, eq, inArray, ne } from '@exatech/db';
import { financialYear, todayIST, validatePattern } from '@exatech/domain';
import { AuditService } from '../../core/audit/audit.service';
import { AccessService } from '../../core/auth/access.service';
import { branchScope } from '../../core/context';
import { Db, inBranchScope } from '../../core/db';
import { invalid } from '../../core/errors';
import { NumberingService } from '../../core/numbering.service';
import { FinanceShared, withDefaults, type FinSettings } from './finance.shared';

type Body = Omit<FinSettings, 'restructureApprovalAbove' | 'chequeUnlocksAfterClearance'>;

/** Finance settings live in institution.settings.finance (numbering, tax, late fee, methods, allocation, UPI). */
@Injectable()
export class FinanceSettingsService {
  constructor(
    private readonly db: Db,
    private readonly shared: FinanceShared,
    private readonly numbering: NumberingService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<FinanceSettingsView> {
    const inst = await this.shared.institution();
    const fin = inst.fin;
    const scope = branchScope();
    const [branch] = await this.db.db
      .select({ id: s.branch.id, code: s.branch.code })
      .from(s.branch)
      .where(scope ? inArray(s.branch.id, scope) : undefined)
      .orderBy(asc(s.branch.openedOn))
      .limit(1);
    const fy = financialYear(todayIST());
    const peek = async (doc: string) => (branch ? this.db.tx((tx) => this.numbering.peek(tx, branch.id, doc, fy)) : 1);
    const [inv] = await this.db.db.select({ id: s.invoice.id }).from(s.invoice).where(and(inBranchScope(s.invoice.branchId), ne(s.invoice.status, 'cancelled'))).orderBy(desc(s.invoice.createdAt)).limit(1);
    const [rec] = await this.db.db.select({ id: s.receipt.id }).from(s.receipt).where(and(inBranchScope(s.receipt.branchId), eq(s.receipt.voided, false))).orderBy(desc(s.receipt.issuedAt)).limit(1);
    const [enr] = await this.db.db.select({ id: s.enrollment.id }).from(s.enrollment).where(and(inBranchScope(s.enrollment.branchId), eq(s.enrollment.status, 'active'))).limit(1);
    return {
      numbering: fin.numbering,
      gstRate: fin.gstRate,
      sac: fin.sac,
      lateFee: fin.lateFee,
      minPartial: fin.minPartial,
      allocationOrder: fin.allocationOrder,
      methods: fin.methods,
      upiVpa: fin.upiVpa,
      reminderDaysBefore: fin.reminderDaysBefore,
      reminderDaysAfter: fin.reminderDaysAfter,
      restructureApprovalAbove: fin.restructureApprovalAbove,
      chequeUnlocksAfterClearance: fin.chequeUnlocksAfterClearance,
      discountThresholds: inst.settings.discountThresholds,
      preview: { branchCode: branch?.code ?? 'TVM', fy, invoiceSeq: await peek('invoice'), receiptSeq: await peek('receipt'), creditNoteSeq: await peek('credit_note') },
      samples: { invoiceId: inv?.id ?? null, receiptId: rec?.id ?? null, enrollmentId: enr?.id ?? null },
    };
  }

  async save(body: Body): Promise<FinanceSettingsView> {
    for (const [k, p] of Object.entries(body.numbering)) {
      const v = validatePattern(p);
      if (!v.ok) throw invalid(`${k === 'credit_note' ? 'Credit note' : k[0]!.toUpperCase() + k.slice(1)} series: ${v.reason}`, { [`numbering.${k}`]: v.reason! });
    }
    if (!['upi', 'cash', 'card', 'cheque', 'transfer'].some((m) => body.methods[m as keyof Body['methods']])) throw invalid('Keep at least one desk payment method switched on');
    if (body.methods.upi === false && body.upiVpa) {
      /* allowed: VPA kept for later */
    }
    await this.db.tx(async (tx) => {
      const [inst] = await tx.select().from(s.institution).limit(1).for('update');
      if (!inst) throw invalid('Institution not configured');
      const before = withDefaults(inst.settings.finance as FinSettings);
      const next: FinSettings = { ...before, ...body, reminderDaysBefore: [...new Set(body.reminderDaysBefore)].sort((a, b) => b - a), reminderDaysAfter: [...new Set(body.reminderDaysAfter)].sort((a, b) => a - b) };
      await tx.update(s.institution).set({ settings: { ...inst.settings, finance: next } }).where(eq(s.institution.id, inst.id));
      const changed = (Object.keys(body) as (keyof Body)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]));
      await this.audit.log(tx, {
        action: 'Finance settings saved',
        kind: 'update',
        entityType: 'settings',
        entityLabel: 'finance',
        before: Object.fromEntries(changed.map((k) => [k, before[k]])),
        after: Object.fromEntries(changed.map((k) => [k, next[k]])),
        summary: changed.length ? `Changed: ${changed.join(', ')}` : 'No changes',
        branchId: null,
      });
    });
    this.access.invalidateInstitution();
    return this.get();
  }
}
