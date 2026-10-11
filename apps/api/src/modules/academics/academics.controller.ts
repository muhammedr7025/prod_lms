import { Controller, Param, Query, Res } from '@nestjs/common';
import {
  academicsBatchesContract,
  academicsMarksContract,
  academicsMaterialsContract,
  academicsOverviewContract,
  academicsStudentsContract,
  academicsTimetableContract,
  DOCUMENT_PATHS,
} from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, eq } from '@exatech/db';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AuditService } from '../../core/audit/audit.service';
import { assertInScope, branchScope, can, ctx } from '../../core/context';
import { Db } from '../../core/db';
import { forbidden, invalid, notFound } from '../../core/errors';
import { Can, Endpoint, Input, type Args } from '../../core/http';
import { ScopeService } from '../../core/scope.service';
import { AcademicsShared } from './academics.shared';
import { BatchesService } from './batches.service';
import { IdCardsService } from './id-cards.service';
import { StudentImportService } from './import.service';
import { MarksService } from './marks.service';
import { MaterialsService } from './materials.service';
import { OverviewService } from './overview.service';
import { StudentsService } from './students.service';
import { TimetableService } from './timetable.service';

const ok = { ok: true as const };

@Controller()
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Endpoint(academicsOverviewContract.overview)
  @Can('academics:overview.read')
  async get() {
    return this.overview.overview();
  }

  @Endpoint(academicsOverviewContract.decideLeave)
  @Can('academics:leave.approve')
  async decideLeave(@Input() { params, body }: Args<typeof academicsOverviewContract.decideLeave>) {
    await this.overview.decideLeave(params.id, body.decision, body.note);
    return ok;
  }

  @Endpoint(academicsTimetableContract.acknowledge)
  @Can('academics:adhoc.acknowledge')
  async acknowledge(@Input() { params }: Args<typeof academicsTimetableContract.acknowledge>) {
    await this.overview.acknowledge(params.id);
    return ok;
  }
}

@Controller()
export class BatchesController {
  constructor(private readonly batches: BatchesService) {}

  @Endpoint(academicsBatchesContract.list)
  @Can('academics:courses.read')
  async list() {
    return this.batches.list();
  }

  @Endpoint(academicsBatchesContract.plan)
  @Can('academics:courses.manage')
  async plan(@Input() { body }: Args<typeof academicsBatchesContract.plan>) {
    return this.batches.plan(body);
  }

  @Endpoint(academicsBatchesContract.create)
  @Can('academics:courses.manage')
  async create(@Input() { body }: Args<typeof academicsBatchesContract.create>) {
    return this.batches.create(body);
  }

  @Endpoint(academicsBatchesContract.update)
  @Can('academics:courses.manage')
  async update(@Input() { params, body }: Args<typeof academicsBatchesContract.update>) {
    return this.batches.update(params.id, body);
  }

  @Endpoint(academicsBatchesContract.assign)
  @Can('academics:courses.manage')
  async assign(@Input() { params, body }: Args<typeof academicsBatchesContract.assign>) {
    return this.batches.assign(params.id, body);
  }

  @Endpoint(academicsBatchesContract.offer)
  @Can('academics:courses.manage')
  async offer(@Input() { body }: Args<typeof academicsBatchesContract.offer>) {
    return this.batches.offer(body);
  }
}

@Controller()
export class TimetableController {
  constructor(
    private readonly db: Db,
    private readonly timetable: TimetableService,
  ) {}

  @Endpoint(academicsTimetableContract.week)
  @Can('academics:timetable.read', 'academics:timetable.manage')
  async week(@Input() { query }: Args<typeof academicsTimetableContract.week>) {
    return this.timetable.week(query.week);
  }

  @Endpoint(academicsTimetableContract.validate)
  @Can('academics:timetable.manage')
  async validate(@Input() { body }: Args<typeof academicsTimetableContract.validate>) {
    if (body.id) {
      const [row] = await this.db.db.select().from(s.classSession).where(eq(s.classSession.id, body.id));
      if (!row) throw notFound('Session');
      assertInScope(row.branchId);
      if (row.attendanceSubmittedAt) return { ok: false, issues: [{ code: 'LOCKED', message: 'Attendance is already submitted for this session' }] };
    }
    const v = await this.timetable.validate(this.db.db, body);
    return { ok: v.issues.length === 0, issues: v.issues.map((i) => ({ code: i.code, message: i.message })) };
  }

  @Endpoint(academicsTimetableContract.create)
  @Can('academics:timetable.manage')
  async create(@Input() { body }: Args<typeof academicsTimetableContract.create>) {
    return this.timetable.create(body);
  }

  @Endpoint(academicsTimetableContract.update)
  @Can('academics:timetable.manage')
  async update(@Input() { params, body }: Args<typeof academicsTimetableContract.update>) {
    return this.timetable.update(params.id, body);
  }

  @Endpoint(academicsTimetableContract.remove)
  @Can('academics:timetable.manage')
  async remove(@Input() { params }: Args<typeof academicsTimetableContract.remove>) {
    await this.timetable.remove(params.id);
    return ok;
  }

  @Endpoint(academicsTimetableContract.restore)
  @Can('academics:timetable.manage')
  async restore(@Input() { params }: Args<typeof academicsTimetableContract.restore>) {
    await this.timetable.restore(params.id);
    return ok;
  }

  @Endpoint(academicsTimetableContract.moveRoom)
  @Can('academics:timetable.manage')
  async moveRoom(@Input() { params, body }: Args<typeof academicsTimetableContract.moveRoom>) {
    await this.timetable.moveRoom(params.id, body.roomId);
    return ok;
  }

  @Endpoint(academicsTimetableContract.substitute)
  @Can('academics:timetable.manage')
  async substitute(@Input() { params, body }: Args<typeof academicsTimetableContract.substitute>) {
    await this.timetable.substitute(params.id, body.teacherUserId);
    return ok;
  }
}

@Controller()
export class StudentsController {
  constructor(
    private readonly students: StudentsService,
    private readonly imports: StudentImportService,
  ) {}

  @Endpoint(academicsStudentsContract.list)
  @Can('academics:students.read')
  async list(@Input() { query }: Args<typeof academicsStudentsContract.list>) {
    return this.students.list(query);
  }

  @Endpoint(academicsStudentsContract.importPreview)
  @Can('academics:students.manage')
  async importPreview(@Input() { body }: Args<typeof academicsStudentsContract.importPreview>) {
    return this.imports.preview(body.fileId);
  }

  @Endpoint(academicsStudentsContract.importCommit)
  @Can('academics:students.manage')
  async importCommit(@Input() { body }: Args<typeof academicsStudentsContract.importCommit>) {
    return this.imports.commit(body.fileId);
  }

  @Endpoint(academicsStudentsContract.get)
  @Can('academics:students.read')
  async get(@Input() { params }: Args<typeof academicsStudentsContract.get>) {
    return this.students.detail(params.id);
  }

  @Endpoint(academicsStudentsContract.transferOptions)
  @Can('academics:students.manage')
  async transferOptions(@Input() { params }: Args<typeof academicsStudentsContract.transferOptions>) {
    return this.students.transferOptions(params.id);
  }

  @Endpoint(academicsStudentsContract.transfer)
  @Can('academics:students.manage')
  async transfer(@Input() { params, body }: Args<typeof academicsStudentsContract.transfer>) {
    return this.students.transfer(params.id, body);
  }

  @Endpoint(academicsStudentsContract.reissueCard)
  @Can('academics:students.manage')
  async reissue(@Input() { params }: Args<typeof academicsStudentsContract.reissueCard>) {
    await this.students.reissueCard(params.id);
    return ok;
  }
}

/** ID cards (PDF). DOCUMENT_PATHS.idCard is shared with the portals (own card / child's card). */
@Controller()
export class IdCardsController {
  constructor(
    private readonly students: StudentsService,
    private readonly cards: IdCardsService,
    private readonly shared: AcademicsShared,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly db: Db,
  ) {}

  private async send(reply: FastifyReply, buffer: Buffer, filename: string) {
    void reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${filename}"`).header('Cache-Control', 'no-store').send(buffer);
  }

  @Endpoint({ method: 'GET', path: '/api/documents/id-cards.pdf', response: z.any() })
  @Can('academics:students.manage')
  async sheet(@Query() raw: Record<string, string>, @Res() reply: FastifyReply) {
    const batchId = z.string().uuid().safeParse(raw.batchId);
    if (!batchId.success) throw invalid('Choose a batch', { batchId: 'Required' });
    const [batch] = await this.db.db.select({ id: s.batch.id, code: s.batch.code, branchId: s.batch.branchId }).from(s.batch).where(eq(s.batch.id, batchId.data));
    if (!batch) throw notFound('Batch');
    assertInScope(batch.branchId);
    const rows = await this.students.cardData(and(eq(s.enrollment.batchId, batch.id), eq(s.student.status, 'active'))!);
    if (rows.length === 0) throw invalid(`${batch.code} has no active students`);
    for (const r of rows) if (!r.cardToken) r.cardToken = await this.students.ensureToken(r.id);
    const pdf = await this.cards.render(
      await this.shared.institutionName(),
      rows.map((r) => ({ name: r.name, admissionNo: r.admissionNo, cardToken: r.cardToken!, batchCode: r.batchCode, courseName: r.courseName, branchName: r.branchName, validUntil: r.batchEnd })),
      batch.code,
    );
    await this.audit.log(this.db.db, { action: 'ID cards printed', kind: 'export', entityType: 'batch', entityId: batch.id, entityLabel: batch.code, summary: `${batch.code} · ${rows.length} ID cards`, branchId: batch.branchId });
    await this.send(reply, pdf, `id-cards-${batch.code}.pdf`);
  }

  @Endpoint({ method: 'GET', path: DOCUMENT_PATHS.idCard(':studentId'), response: z.any() })
  @Can('academics:students.read', 'portal:student', 'portal:parent')
  async one(@Param('studentId') studentId: string, @Res() reply: FastifyReply) {
    const id = z.string().uuid().safeParse(studentId);
    if (!id.success) throw notFound('Student');
    const [row] = await this.students.cardData(eq(s.student.id, id.data));
    if (!row) throw notFound('Student');
    const c = ctx();
    if (can('academics:students.read')) {
      const sc = branchScope();
      if (sc && !sc.includes(row.branchId)) throw forbidden('This student is outside the selected branch');
    } else {
      const mine = c.roleKey === 'parent' ? await this.scope.parentChildren() : await this.scope.studentEnrollments();
      if (!mine.some((m) => m.studentId === row.id)) throw forbidden('That student is not linked to your account');
    }
    const token = row.cardToken ?? (await this.students.ensureToken(row.id));
    const pdf = await this.cards.render(
      await this.shared.institutionName(),
      [{ name: row.name, admissionNo: row.admissionNo, cardToken: token, batchCode: row.batchCode, courseName: row.courseName, branchName: row.branchName, validUntil: row.batchEnd }],
      row.admissionNo ?? row.name,
    );
    await this.audit.log(this.db.db, { action: 'ID card printed', kind: 'export', entityType: 'student', entityId: row.id, entityLabel: `${row.name} · ${row.admissionNo ?? ''}`, summary: `ID card PDF · ${row.name}`, branchId: row.branchId });
    await this.send(reply, pdf, `id-card-${(row.admissionNo ?? row.id).replace(/[^\w-]+/g, '_')}.pdf`);
  }
}

@Controller()
export class MaterialsController {
  constructor(private readonly materials: MaterialsService) {}

  @Endpoint(academicsMaterialsContract.list)
  @Can('academics:materials.read')
  async list() {
    return this.materials.list();
  }

  @Endpoint(academicsMaterialsContract.preview)
  @Can('academics:materials.read')
  async preview(@Input() { params }: Args<typeof academicsMaterialsContract.preview>) {
    return this.materials.preview(params.id);
  }

  @Endpoint(academicsMaterialsContract.visibility)
  @Can('academics:courses.manage', 'teaching:materials.manage')
  async visibility(@Input() { params, body }: Args<typeof academicsMaterialsContract.visibility>) {
    await this.materials.setVisibility(params.id, body.visibility, body.releaseOn);
    return ok;
  }

  @Endpoint(academicsMaterialsContract.upload)
  @Can('academics:courses.manage', 'teaching:materials.manage')
  async upload(@Input() { body }: Args<typeof academicsMaterialsContract.upload>) {
    return this.materials.upload(body);
  }
}

@Controller()
export class MarksController {
  constructor(private readonly marks: MarksService) {}

  @Endpoint(academicsMarksContract.list)
  @Can('academics:marks.read', 'academics:marks.publish')
  async list() {
    return this.marks.list();
  }

  @Endpoint(academicsMarksContract.get)
  @Can('academics:marks.read', 'academics:marks.publish', 'teaching:marks.enter')
  async get(@Input() { params }: Args<typeof academicsMarksContract.get>) {
    return this.marks.detail(params.id);
  }

  @Endpoint(academicsMarksContract.publish)
  @Can('academics:marks.publish')
  async publish(@Input() { params }: Args<typeof academicsMarksContract.publish>) {
    await this.marks.publish(params.id);
    return ok;
  }

  @Endpoint(academicsMarksContract.returnExam)
  @Can('academics:marks.publish')
  async returnExam(@Input() { params, body }: Args<typeof academicsMarksContract.returnExam>) {
    await this.marks.returnExam(params.id, body.note);
    return ok;
  }
}
