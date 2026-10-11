import { Injectable } from '@nestjs/common';
import type { AcadMaterialRow, AcadTag } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, desc, eq, inArray, isNull, sql } from '@exatech/db';
import { formatDayMonth, istDateTime, todayIST, toISTDate } from '@exatech/domain';
import { AuditService } from '../../core/audit/audit.service';
import { assertInScope, can, ctx } from '../../core/context';
import { Db, inBranchScope } from '../../core/db';
import { forbidden, invalid, notFound } from '../../core/errors';
import { EventBus } from '../../core/events/event-bus';
import { FilesService } from '../../core/files/files.service';
import { NotifyService } from '../../core/notifications/notify.service';
import { ScopeService } from '../../core/scope.service';
import { AcademicsShared, policyLabel, scopeSql } from './academics.shared';

type Visibility = 'always' | 'fee_gated' | 'scheduled';
const VIS_TAG: Record<Visibility, AcadTag> = { always: 'accent', fee_gated: 'outline', scheduled: 'neutral' };

function visLabel(v: Visibility, releaseAt: Date | null): string {
  if (v === 'always') return 'Always visible';
  if (v === 'fee_gated') return 'Fee-gated';
  return releaseAt ? `Scheduled · ${formatDayMonth(toISTDate(releaseAt))}` : 'Scheduled';
}

/** Notes & material oversight: all material across batches, visibility changes and admin uploads. */
@Injectable()
export class MaterialsService {
  constructor(
    private readonly db: Db,
    private readonly shared: AcademicsShared,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly files: FilesService,
    private readonly notify: NotifyService,
    private readonly scope: ScopeService,
  ) {}

  async list() {
    const rows = await this.db.db
      .select({
        m: s.material,
        batchCode: s.batch.code,
        batchStatus: s.batch.status,
        by: s.user.name,
        opened: sql<number>`(select count(distinct ma.user_id)::int from material_access ma where ma.material_id = ${s.material.id})`,
        roster: sql<number>`(select count(*)::int from enrollment e where e.batch_id = ${s.material.batchId} and e.status = 'active')`,
      })
      .from(s.material)
      .innerJoin(s.batch, eq(s.batch.id, s.material.batchId))
      .innerJoin(s.user, eq(s.user.id, s.material.uploadedBy))
      .where(and(inBranchScope(s.material.branchId), isNull(s.material.removedAt)))
      .orderBy(asc(s.batch.code), asc(s.material.module), desc(s.material.createdAt));
    const running = rows.filter((r) => r.batchStatus === 'running');
    const [locked] = await this.db.db.execute<{ n: string }>(sql`
      select count(*) as n from enrollment e
      where e.status = 'active' and not e.fee_cleared and ${scopeSql(sql`e.branch_id`)}
        and exists (select 1 from material m where m.batch_id = e.batch_id and m.visibility = 'fee_gated' and m.removed_at is null)`);
    const [downloads] = await this.db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.materialAccess)
      .innerJoin(s.material, eq(s.material.id, s.materialAccess.materialId))
      .where(and(inBranchScope(s.material.branchId), sql`${s.materialAccess.at} >= ${istDateTime(todayIST()).toISOString()}::timestamptz`));
    const settings = await this.shared.settings();
    const courses = await this.db.db.select({ code: s.course.code, name: s.course.name, policy: s.course.clearancePolicy }).from(s.course).where(eq(s.course.status, 'active')).orderBy(asc(s.course.code));
    const batches = await this.uploadableBatches();
    const items: AcadMaterialRow[] = rows.map((r) => {
      const v = r.m.visibility as Visibility;
      const unopened = v === 'scheduled' && Number(r.opened) === 0;
      return {
        id: r.m.id,
        batchId: r.m.batchId,
        batchCode: r.batchCode,
        module: r.m.module,
        title: r.m.title,
        type: r.m.type,
        visibility: v,
        visibilityLabel: visLabel(v, r.m.releaseAt),
        visibilityTag: VIS_TAG[v],
        releaseOn: r.m.releaseAt ? toISTDate(r.m.releaseAt) : null,
        uploadedBy: r.by,
        opened: unopened ? '—' : `${Number(r.opened)} / ${Number(r.roster)}`,
        meta: r.m.meta,
        previewable: !!(r.m.fileId || r.m.url),
      };
    });
    return {
      branchLabel: await this.shared.branchLabel(),
      kpis: {
        items: running.length,
        feeGated: running.filter((r) => r.m.visibility === 'fee_gated').length,
        lockedOut: Number(locked?.n ?? 0),
        downloadsToday: Number(downloads?.n ?? 0),
      },
      items,
      batches,
      rules: {
        defaultPolicy: policyLabel(settings.clearancePolicy),
        courses: courses.map((c) => ({ code: c.code, name: c.name, policy: c.policy ? policyLabel(c.policy) : `${policyLabel(settings.clearancePolicy)} (institution default)` })),
      },
      canUpload: can('academics:courses.manage') || can('teaching:materials.manage'),
    };
  }

  private async uploadableBatches() {
    const c = ctx();
    const teacherOnly = !can('academics:courses.manage') && c.roleKey === 'teacher';
    const ids = teacherOnly ? await this.scope.teacherBatchIds() : null;
    return this.db.db
      .select({ id: s.batch.id, code: s.batch.code })
      .from(s.batch)
      .where(and(inBranchScope(s.batch.branchId), inArray(s.batch.status, ['planned', 'open', 'running', 'waitlist']), ids ? inArray(s.batch.id, ids.length ? ids : ['00000000-0000-0000-0000-000000000000']) : undefined))
      .orderBy(asc(s.batch.code));
  }

  private async assertBatchWrite(batchId: string) {
    const [b] = await this.db.db.select({ id: s.batch.id, code: s.batch.code, branchId: s.batch.branchId }).from(s.batch).where(eq(s.batch.id, batchId));
    if (!b) throw notFound('Batch');
    assertInScope(b.branchId);
    if (!can('academics:courses.manage')) await this.scope.assertTeacherOfBatch(batchId);
    return b;
  }

  async preview(id: string) {
    const [m] = await this.db.db.select().from(s.material).where(eq(s.material.id, id));
    if (!m || m.removedAt) throw notFound('Material');
    assertInScope(m.branchId);
    if (m.fileId) return this.files.signedUrl(m.fileId, 300);
    if (m.url) return { url: m.url, expiresAt: new Date(Date.now() + 300_000) };
    throw notFound('File');
  }

  async setVisibility(id: string, visibility: Visibility, releaseOn?: string | null) {
    await this.db.tx(async (tx) => {
      const [m] = await tx.select().from(s.material).where(eq(s.material.id, id)).for('update');
      if (!m || m.removedAt) throw notFound('Material');
      await this.assertBatchWrite(m.batchId);
      let releaseAt: Date | null = null;
      if (visibility === 'scheduled') {
        if (!releaseOn) throw invalid('Choose the release date', { releaseOn: 'Required' });
        if (releaseOn < todayIST()) throw invalid('The release date is in the past', { releaseOn: 'Past date' });
        releaseAt = istDateTime(releaseOn, '08:00');
      }
      if (m.visibility === visibility && (m.releaseAt?.getTime() ?? null) === (releaseAt?.getTime() ?? null)) return;
      await tx.update(s.material).set({ visibility, releaseAt }).where(eq(s.material.id, id));
      const [b] = await tx.select({ code: s.batch.code }).from(s.batch).where(eq(s.batch.id, m.batchId));
      await this.events.emit(tx, 'MaterialVisibilityChanged', { materialId: id, batchId: m.batchId, visibility });
      await this.audit.log(tx, {
        action: 'Material visibility changed',
        kind: 'update',
        entityType: 'material',
        entityId: id,
        entityLabel: `${b?.code ?? ''} · ${m.title}`,
        before: { visibility: m.visibility, releaseAt: m.releaseAt },
        after: { visibility, releaseAt },
        summary: `${b?.code ?? ''} · ${m.title} · ${visLabel(m.visibility as Visibility, m.releaseAt)} → ${visLabel(visibility, releaseAt)}`,
        branchId: m.branchId,
      });
      this.notify.invalidate(tx, m.branchId, [['academics'], ['portal'], ['teaching']]);
    });
  }

  async upload(body: { batchId: string; type: (typeof s.material.$inferInsert)['type']; module: string; title: string; visibility: Visibility; releaseOn?: string | null; fileId?: string | null; url?: string | null }) {
    const b = await this.assertBatchWrite(body.batchId);
    const isLinkType = body.type === 'Link' || body.type === 'Video';
    if (body.type === 'Link' && !body.url) throw invalid('Paste the link', { url: 'Required' });
    if (!isLinkType && !body.fileId) throw invalid('Attach the file', { fileId: 'Required' });
    if (body.type === 'Video' && !body.url && !body.fileId) throw invalid('Attach the video or paste its link', { url: 'Required' });
    let size: number | null = null;
    if (body.fileId) {
      const f = await this.files.get(body.fileId);
      if (f.purpose !== 'material') throw invalid('Upload the file as course material', { fileId: 'Wrong purpose' });
      if (f.ownerUserId !== ctx().userId) throw forbidden('This upload belongs to someone else');
      size = f.size;
    }
    let releaseAt: Date | null = null;
    if (body.visibility === 'scheduled') {
      if (!body.releaseOn) throw invalid('Choose the release date', { releaseOn: 'Required' });
      if (body.releaseOn < todayIST()) throw invalid('The release date is in the past', { releaseOn: 'Past date' });
      releaseAt = istDateTime(body.releaseOn, '08:00');
    }
    return this.db.tx(async (tx) => {
      const [m] = await tx
        .insert(s.material)
        .values({
          batchId: b.id,
          branchId: b.branchId,
          module: body.module,
          title: body.title,
          type: body.type,
          visibility: body.visibility,
          releaseAt,
          fileId: body.fileId ?? null,
          url: body.fileId ? null : (body.url ?? null),
          meta: size != null ? (size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`) : body.type === 'Link' ? 'link' : null,
          uploadedBy: ctx().userId,
        })
        .returning({ id: s.material.id });
      await this.events.emit(tx, 'MaterialUploaded', { materialId: m!.id, batchId: b.id, branchId: b.branchId });
      await this.audit.log(tx, {
        action: 'Material uploaded',
        kind: 'create',
        entityType: 'material',
        entityId: m!.id,
        entityLabel: `${b.code} · ${body.title}`,
        after: { module: body.module, type: body.type, visibility: body.visibility, releaseAt },
        summary: `${b.code} · ${body.module} · ${body.title} · ${body.type} · ${visLabel(body.visibility, releaseAt)}`,
        branchId: b.branchId,
      });
      await this.shared.notifyBatch(tx, b.id, {
        category: 'material',
        title: `New material · ${b.code}`,
        body: `${body.title}${body.visibility === 'scheduled' && releaseAt ? ` · available ${formatDayMonth(toISTDate(releaseAt))}` : body.visibility === 'fee_gated' ? ' · unlocks with fee clearance' : ''}`,
        link: '/student/notes',
        entityType: 'material',
        entityId: m!.id,
      });
      this.notify.invalidate(tx, b.branchId, [['academics'], ['portal'], ['teaching']]);
      return { id: m!.id };
    });
  }
}
