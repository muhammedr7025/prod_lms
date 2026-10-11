import { Injectable } from '@nestjs/common';
import { ALWAYS_2FA_ROLES, type SettingsInput, type SettingsView } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, eq, inArray, or } from '@exatech/db';
import { financialYear, todayIST, type ClearancePolicy } from '@exatech/domain';
import { AccessService } from '../../core/auth/access.service';
import { AuditService } from '../../core/audit/audit.service';
import { can } from '../../core/context';
import { Db } from '../../core/db';
import { invalid, notFound } from '../../core/errors';
import { NotifyService } from '../../core/notifications/notify.service';

const policyText = (p: ClearancePolicy) => (p.kind === 'percentage' ? `${p.percentage}% paid` : p.kind === 'fully_paid' ? 'fully paid' : 'current instalment paid');

/** Institution settings: identity, fee-clearance default, discount thresholds, admission numbers, security. */
@Injectable()
export class SettingsService {
  constructor(
    private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
  ) {}

  async get(): Promise<SettingsView> {
    const inst = await this.access.institution();
    const [row] = await this.db.db.select().from(s.institution).where(eq(s.institution.id, inst.id));
    if (!row) throw notFound('Institution');
    // Preview: the next real admission sequence for the head-office branch and its first course.
    const [branch] = await this.db.db.select({ id: s.branch.id, code: s.branch.code }).from(s.branch).where(eq(s.branch.status, 'active')).orderBy(asc(s.branch.openedOn)).limit(1);
    const [course] = await this.db.db.select({ code: s.course.code }).from(s.course).where(eq(s.course.status, 'active')).orderBy(asc(s.course.createdAt), asc(s.course.code)).limit(1);
    const fy = financialYear(todayIST());
    const year = Number(fy.slice(0, 4)) + 1;
    const [seq] = branch
      ? await this.db.db
          .select({ next: s.docSequence.nextSeq })
          .from(s.docSequence)
          .where(and(eq(s.docSequence.scopeId, branch.id), eq(s.docSequence.docType, 'admission'), eq(s.docSequence.period, String(year))))
      : [];
    const roles = await this.db.db
      .select({ key: s.role.key, name: s.role.name })
      .from(s.role)
      .where(and(eq(s.role.institutionId, inst.id), or(eq(s.role.surface, 'staff'), inArray(s.role.key, ['teacher']))))
      .orderBy(asc(s.role.position));
    const st = row.settings;
    return {
      name: row.name,
      legalName: row.legalName,
      gstin: row.gstin ?? '',
      academicYearLabel: row.academicYearLabel,
      academicYearStart: row.academicYearStart,
      brandColor: row.brandColor,
      clearancePolicy: st.clearancePolicy,
      discountThresholds: st.discountThresholds,
      admissionNumberPattern: st.admissionNumberPattern,
      security: {
        require2faRoles: [...new Set([...ALWAYS_2FA_ROLES, ...st.security.require2faRoles])],
        staffSessionHours: st.security.staffSessionHours,
        staffIdleMinutes: st.security.staffIdleMinutes,
        portalSessionDays: st.security.portalSessionDays,
        impersonationMinutes: st.security.impersonationMinutes,
      },
      leadRetentionMonths: st.leadRetentionMonths,
      preview: { branchCode: branch?.code ?? 'TVM', courseCode: course?.code ?? 'DM', year, fy, nextSeq: seq?.next ?? 1 },
      roles,
      locked2faRoles: [...ALWAYS_2FA_ROLES],
      canManage: can('institution:settings.manage'),
    };
  }

  async save(body: SettingsInput & { gstin: string; brandColor: string }): Promise<SettingsView> {
    const inst = await this.access.institution();
    const roleKeys = new Set((await this.db.db.select({ key: s.role.key }).from(s.role).where(eq(s.role.institutionId, inst.id))).map((r) => r.key));
    const unknown = body.security.require2faRoles.find((k) => !roleKeys.has(k));
    if (unknown) throw invalid(`Unknown role ${unknown} in the 2FA list`, { 'security.require2faRoles': 'Unknown role' });
    const require2faRoles = [...new Set([...ALWAYS_2FA_ROLES, ...body.security.require2faRoles])];
    await this.db.tx(async (tx) => {
      const [row] = await tx.select().from(s.institution).where(eq(s.institution.id, inst.id)).for('update');
      if (!row) throw notFound('Institution');
      const prev = row.settings;
      const settings = {
        ...prev,
        clearancePolicy: body.clearancePolicy as ClearancePolicy,
        discountThresholds: { financePct: body.discountThresholds.financePct, superAdminPct: body.discountThresholds.superAdminPct },
        admissionNumberPattern: body.admissionNumberPattern,
        security: { ...prev.security, ...body.security, require2faRoles },
        leadRetentionMonths: body.leadRetentionMonths,
      };
      const changes: string[] = [];
      const cmp = (labelText: string, a: unknown, b: unknown, fmt: (v: unknown) => string = (v) => (v == null || v === '' ? '—' : String(v))) => {
        if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) changes.push(`${labelText} ${fmt(a)} → ${fmt(b)}`);
      };
      cmp('name', row.name, body.name);
      cmp('legal name', row.legalName, body.legalName);
      cmp('GSTIN', row.gstin, body.gstin);
      cmp('academic year', `${row.academicYearLabel} from ${row.academicYearStart}`, `${body.academicYearLabel} from ${body.academicYearStart}`);
      cmp('brand colour', row.brandColor, body.brandColor);
      cmp('fee clearance', policyText(prev.clearancePolicy), policyText(settings.clearancePolicy));
      cmp('discount thresholds', `${prev.discountThresholds.financePct}% / ${prev.discountThresholds.superAdminPct}%`, `${settings.discountThresholds.financePct}% / ${settings.discountThresholds.superAdminPct}%`);
      cmp('admission format', prev.admissionNumberPattern, settings.admissionNumberPattern);
      cmp('2FA roles', [...prev.security.require2faRoles].sort().join(', '), [...require2faRoles].sort().join(', '));
      cmp('staff session', `${prev.security.staffSessionHours} h · idle ${prev.security.staffIdleMinutes} min`, `${settings.security.staffSessionHours} h · idle ${settings.security.staffIdleMinutes} min`);
      cmp('portal session', `${prev.security.portalSessionDays} days`, `${settings.security.portalSessionDays} days`);
      cmp('impersonation', `${prev.security.impersonationMinutes} min`, `${settings.security.impersonationMinutes} min`);
      cmp('lead retention', `${prev.leadRetentionMonths} months`, `${settings.leadRetentionMonths} months`);
      if (changes.length === 0) throw invalid('Nothing changed');
      await tx
        .update(s.institution)
        .set({
          name: body.name,
          legalName: body.legalName,
          gstin: body.gstin,
          academicYearLabel: body.academicYearLabel,
          academicYearStart: body.academicYearStart,
          brandColor: body.brandColor,
          settings,
          updatedAt: new Date(),
        })
        .where(eq(s.institution.id, inst.id));
      await this.audit.log(tx, {
        action: 'Settings changed',
        kind: 'update',
        entityType: 'institution',
        entityId: inst.id,
        entityLabel: body.name,
        before: { name: row.name, gstin: row.gstin, brandColor: row.brandColor, academicYear: row.academicYearLabel, settings: prev },
        after: { name: body.name, gstin: body.gstin, brandColor: body.brandColor, academicYear: body.academicYearLabel, settings },
        summary: changes.join(' · '),
        branchId: null,
      });
      // Every open shell refetches /me so the brand colour and session rules apply at once.
      this.notify.invalidate(tx, null, [['me'], ['institution']]);
    });
    this.access.invalidateInstitution();
    await this.access.bump();
    return this.get();
  }
}
