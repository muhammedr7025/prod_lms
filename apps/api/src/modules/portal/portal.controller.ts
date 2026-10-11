import { Controller, Param, Query, Res } from '@nestjs/common';
import { DOCUMENT_PATHS, PORTAL_PATHS, portalContract } from '@exatech/contracts';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { notFound } from '../../core/errors';
import { Can, Endpoint, Input, type Args } from '../../core/http';
import { FeesService } from './fees.service';
import { HomeService } from './home.service';
import { MarksService } from './marks.service';
import { NotesService } from './notes.service';
import { ParentService } from './parent.service';
import { TimetableService } from './timetable.service';
import { WorkService } from './work.service';

/**
 * Student & Parent portals (BFF). Every handler resolves scope through
 * ScopeService.portalEnrollment(studentId?) — students see their own
 * enrollment, parents a linked child. GETs render during read-only
 * impersonation; writes are refused by the guard.
 */
@Controller()
export class PortalController {
  constructor(
    private readonly home: HomeService,
    private readonly timetable: TimetableService,
    private readonly notes: NotesService,
    private readonly work: WorkService,
    private readonly marks: MarksService,
    private readonly fees: FeesService,
    private readonly parent: ParentService,
  ) {}

  @Endpoint(portalContract.children)
  @Can('portal:student', 'portal:parent')
  async children() {
    return this.home.children();
  }

  @Endpoint(portalContract.home)
  @Can('portal:student', 'portal:parent')
  async homeScreen(@Input() { query }: Args<typeof portalContract.home>) {
    return this.home.home(query.studentId);
  }

  @Endpoint(portalContract.timetable)
  @Can('portal:student', 'portal:parent')
  async week(@Input() { query }: Args<typeof portalContract.timetable>) {
    return this.timetable.week(query.studentId, query.week);
  }

  /** text/calendar download of the next 8 weeks (classes, exams, holidays). */
  @Endpoint({ method: 'GET', path: PORTAL_PATHS.timetableIcs, response: z.any() })
  @Can('portal:student', 'portal:parent')
  async ics(@Query('studentId') studentId: string | undefined, @Res() reply: FastifyReply) {
    const id = studentId ? z.string().uuid().safeParse(studentId) : null;
    if (id && !id.success) throw notFound('Student');
    const { body, filename } = await this.timetable.ics(id?.data);
    void reply
      .header('Content-Type', 'text/calendar; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .header('Cache-Control', 'no-store')
      .send(body);
  }

  @Endpoint(portalContract.notes)
  @Can('portal:student', 'portal:parent')
  async notesList(@Input() { query }: Args<typeof portalContract.notes>) {
    return this.notes.list(query.studentId);
  }

  @Endpoint(portalContract.openNote)
  @Can('portal:student')
  async openNote(@Input() { params }: Args<typeof portalContract.openNote>) {
    if (!z.string().uuid().safeParse(params.id).success) throw notFound('Note');
    return this.notes.open(params.id);
  }

  @Endpoint(portalContract.work)
  @Can('portal:student')
  async workList() {
    return this.work.list();
  }

  @Endpoint(portalContract.submitWork)
  @Can('portal:student')
  async submit(@Input() { params, body }: Args<typeof portalContract.submitWork>) {
    if (!z.string().uuid().safeParse(params.id).success) throw notFound('Assignment');
    return this.work.submit(params.id, body);
  }

  @Endpoint(portalContract.marks)
  @Can('portal:student', 'portal:parent')
  async marksList(@Input() { query }: Args<typeof portalContract.marks>) {
    return this.marks.marks(query.studentId);
  }

  /** Report card PDF (student, linked parent, or staff in branch scope). */
  @Endpoint({ method: 'GET', path: DOCUMENT_PATHS.reportCard(':enrollmentId'), response: z.any() })
  @Can('portal:student', 'portal:parent', 'academics:students.read')
  async reportCard(@Param('enrollmentId') enrollmentId: string, @Res() reply: FastifyReply) {
    if (!z.string().uuid().safeParse(enrollmentId).success) throw notFound('Report card');
    const pdf = await this.marks.reportCard(enrollmentId);
    void reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${pdf.filename}"`).header('Cache-Control', 'no-store').send(pdf.buffer);
  }

  @Endpoint(portalContract.fees)
  @Can('portal:student', 'portal:parent')
  async feesScreen(@Input() { query }: Args<typeof portalContract.fees>) {
    return this.fees.fees(query.studentId);
  }

  @Endpoint(portalContract.attendance)
  @Can('portal:student', 'portal:parent')
  async attendance(@Input() { query }: Args<typeof portalContract.attendance>) {
    return this.parent.attendance(query.studentId);
  }

  @Endpoint(portalContract.alerts)
  @Can('portal:parent', 'portal:student')
  async alerts() {
    return this.parent.alerts();
  }

  @Endpoint(portalContract.messageTeacher)
  @Can('portal:parent')
  async message(@Input() { body }: Args<typeof portalContract.messageTeacher>) {
    return this.parent.message(body);
  }

  @Endpoint(portalContract.requestPtm)
  @Can('portal:parent')
  async ptm(@Input() { body }: Args<typeof portalContract.requestPtm>) {
    return this.parent.ptm(body);
  }
}
