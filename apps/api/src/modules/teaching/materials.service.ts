import { Injectable } from '@nestjs/common';
import { TEACH_MATERIAL_TYPES, TEACH_VISIBILITIES, type TeachBatch, type TeachMaterialRow, type TeachTag } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from '@exatech/db';
import { formatDayMonth, istDateTime, todayIST, toISTDate } from '@exatech/domain';
import { AuditService } from '../../core/audit/audit.service';
import { ctx } from '../../core/context';
import { Db } from '../../core/db';
import { forbidden, invalid, notFound } from '../../core/errors';
import { EventBus } from '../../core/events/event-bus';
import { FilesService } from '../../core/files/files.service';
import { NotifyService } from '../../core/notifications/notify.service';
import { TeachingShared } from './teaching.shared';

type Visibility = (typeof TEACH_VISIBILITIES)[number];
type MaterialType = (typeof TEACH_MATERIAL_TYPES)[number];

const VIS_TAG: Record<Visibility, TeachTag> = { always: 'accent', fee_gated: 'outline', scheduled: 'neutral' };

export function visLabel(v: Visibility, releaseAt: Date | null): string {
  if (v === 'always') return 'Always visible';
  if (v === 'fee_gated') return 'Fee-gated';
  return releaseAt ? `Scheduled · ${formatDayMonth(toISTDate(releaseAt))}` : 'Scheduled';
}

function sizeLabel(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Teacher · Notes & material: per-batch list by module, upload, visibility cycling, remove + undo. */
@Injectable()
export class TeachingMaterialsService {
  constructor(
    private readonly db: Db,
    private readonly shared: TeachingShared,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly notify: NotifyService,
    private readonly files: FilesService,
  ) {}

  async list(batchId?: string): Promise<{
    batches: TeachBatch[];
    batchId: string | null;
    batchCode: string | null;
    count: number;
    groups: { module: string; items: TeachMaterialRow[] }[];
    modules: string[];
  }> {
    const batches = await this.shared.myBatches();
    if (batchId && !batches.some((b) => b.id === batchId)) throw forbidden('This batch is not assigned to you');
    const current = batches.find((b) => b.id === batchId) ?? batches[0] ?? null;
    const modulesRows = batches.length
      ? await this.db.db
          .selectDistinct({ module: s.material.module })
          .from(s.material)
          .where(and(inArray(s.material.batchId, batches.map((b) => b.id)), isNull(s.material.removedAt)))
          .orderBy(asc(s.material.module))
      : [];
    if (!current) return { batches, batchId: null, batchCode: null, count: 0, groups: [], modules: [] };
    const rows = await this.db.db
      .select({
        m: s.material,
        opened: sql<number>`(select count(distinct ma.user_id)::int from material_access ma where ma.material_id = material.id)`,
      })
      .from(s.material)
      .where(and(eq(s.material.batchId, current.id), isNull(s.material.removedAt)))
      .orderBy(asc(s.material.module), asc(s.material.createdAt));
    const groups: { module: string; items: TeachMaterialRow[] }[] = [];
    for (const r of rows) {
      const v = r.m.visibility as Visibility;
      const opened = Number(r.opened);
      const item: TeachMaterialRow = {
        id: r.m.id,
        type: r.m.type as MaterialType,
        title: r.m.title,
        meta: r.m.meta ?? (r.m.url ? 'link' : r.m.type),
        opened: v === 'scheduled' && opened === 0 ? '—' : `${opened} / ${current.students}`,
        visibility: v,
        visibilityLabel: visLabel(v, r.m.releaseAt),
        tag: VIS_TAG[v],
        releaseOn: r.m.releaseAt ? toISTDate(r.m.releaseAt) : null,
      };
      const g = groups.find((x) => x.module === r.m.module);
      if (g) g.items.push(item);
      else groups.push({ module: r.m.module, items: [item] });
    }
    groups.sort((a, b) => a.module.localeCompare(b.module, undefined, { numeric: true }));
    return { batches, batchId: current.id, batchCode: current.code, count: rows.length, groups, modules: modulesRows.map((m) => m.module) };
  }

  private async mine(id: string, includeRemoved = false) {
    const [m] = await this.db.db.select().from(s.material).where(eq(s.material.id, id));
    if (!m || (!includeRemoved && m.removedAt)) throw notFound('Material');
    const b = await this.shared.myBatch(m.batchId);
    return { m, b };
  }

  private releaseAt(visibility: Visibility, releaseOn?: string | null): Date | null {
    if (visibility !== 'scheduled') return null;
    if (!releaseOn) throw invalid('Choose the release date', { releaseOn: 'Required' });
    if (releaseOn < todayIST()) throw invalid('The release date is in the past', { releaseOn: 'Past date' });
    return istDateTime(releaseOn, '08:00');
  }

  async upload(body: { batchId: string; type: MaterialType; module: string; title: string; visibility: Visibility; releaseOn?: string | null; fileId?: string | null; url?: string | null }): Promise<{ id: string }> {
    const b = await this.shared.myBatch(body.batchId);
    const linkType = body.type === 'Link' || body.type === 'Video';
    if (linkType && !body.url && !(body.type === 'Video' && body.fileId)) throw invalid(body.type === 'Video' ? 'Paste the video link' : 'Paste the link', { url: 'Required' });
    if (!linkType && !body.fileId) throw invalid('Attach the file', { fileId: 'Required' });
    let size: number | null = null;
    if (body.fileId) {
      const f = await this.files.get(body.fileId);
      if (f.purpose !== 'material') throw invalid('Upload the file as course material', { fileId: 'Wrong purpose' });
      if (f.ownerUserId !== ctx().userId) throw forbidden('This upload belongs to someone else');
      size = f.size;
    }
    const releaseAt = this.releaseAt(body.visibility, body.releaseOn);
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
          meta: size != null ? `${sizeLabel(size)}${body.type === 'PDF' ? ' · watermarked' : ''}` : body.type === 'Video' ? 'video link' : 'link',
          uploadedBy: ctx().userId,
        })
        .returning({ id: s.material.id });
      const id = m!.id;
      await this.events.emit(tx, 'MaterialUploaded', { materialId: id, batchId: b.id, branchId: b.branchId });
      await this.audit.log(tx, {
        action: 'Material uploaded',
        kind: 'create',
        entityType: 'material',
        entityId: id,
        entityLabel: `${b.code} · ${body.title}`,
        after: { module: body.module, type: body.type, visibility: body.visibility, releaseAt },
        summary: `${b.code} · ${body.module} · ${body.title} · ${body.type} · ${visLabel(body.visibility, releaseAt)}`,
        branchId: b.branchId,
      });
      await this.notify.notify(tx, {
        userIds: await this.shared.batchStudentUserIds(tx, b.id),
        category: 'material',
        title: `New material · ${b.code}`,
        body: `${body.title}${body.visibility === 'scheduled' && releaseAt ? ` · available ${formatDayMonth(toISTDate(releaseAt))}` : body.visibility === 'fee_gated' ? ' · unlocks with fee clearance' : ''}`,
        link: '/student/notes',
        entityType: 'material',
        entityId: id,
      });
      this.notify.invalidate(tx, b.branchId, [['teaching'], ['academics'], ['portal']]);
      return { id };
    });
  }

  async setVisibility(id: string, visibility: Visibility, releaseOn?: string | null): Promise<void> {
    const { m, b } = await this.mine(id);
    const releaseAt = this.releaseAt(visibility, releaseOn);
    if (m.visibility === visibility && (m.releaseAt?.getTime() ?? null) === (releaseAt?.getTime() ?? null)) return;
    await this.db.tx(async (tx) => {
      await tx.update(s.material).set({ visibility, releaseAt }).where(eq(s.material.id, id));
      await this.events.emit(tx, 'MaterialVisibilityChanged', { materialId: id, batchId: m.batchId, visibility });
      await this.audit.log(tx, {
        action: 'Material visibility changed',
        kind: 'update',
        entityType: 'material',
        entityId: id,
        entityLabel: `${b.code} · ${m.title}`,
        before: { visibility: m.visibility, releaseAt: m.releaseAt },
        after: { visibility, releaseAt },
        summary: `${b.code} · ${m.title} · ${visLabel(m.visibility as Visibility, m.releaseAt)} → ${visLabel(visibility, releaseAt)}`,
        branchId: m.branchId,
      });
      this.notify.invalidate(tx, m.branchId, [['teaching'], ['academics'], ['portal']]);
    });
  }

  async remove(id: string): Promise<void> {
    const { m, b } = await this.mine(id);
    await this.db.tx(async (tx) => {
      await tx.update(s.material).set({ removedAt: new Date() }).where(and(eq(s.material.id, id), isNull(s.material.removedAt)));
      await this.audit.log(tx, {
        action: 'Material removed',
        kind: 'delete',
        entityType: 'material',
        entityId: id,
        entityLabel: `${b.code} · ${m.title}`,
        before: { removedAt: null },
        after: { removedAt: new Date().toISOString() },
        summary: `${b.code} · ${m.module} · ${m.title} · hidden from students (soft delete)`,
        branchId: m.branchId,
      });
      this.notify.invalidate(tx, m.branchId, [['teaching'], ['academics'], ['portal']]);
    });
  }

  async restore(id: string): Promise<void> {
    const { m, b } = await this.mine(id, true);
    if (!m.removedAt) return;
    await this.db.tx(async (tx) => {
      await tx.update(s.material).set({ removedAt: null }).where(and(eq(s.material.id, id), isNotNull(s.material.removedAt)));
      await this.audit.log(tx, {
        action: 'Material restored',
        kind: 'update',
        entityType: 'material',
        entityId: id,
        entityLabel: `${b.code} · ${m.title}`,
        before: { removedAt: m.removedAt },
        after: { removedAt: null },
        summary: `${b.code} · ${m.title} · removal undone`,
        branchId: m.branchId,
      });
      this.notify.invalidate(tx, m.branchId, [['teaching'], ['academics'], ['portal']]);
    });
  }
}
