import { Controller } from '@nestjs/common';
import {
  checkinContract,
  teachingAssignmentsContract,
  teachingAttendanceContract,
  teachingCoverContract,
  teachingLeaveContract,
  teachingMarksContract,
  teachingMaterialsContract,
  teachingTodayContract,
} from '@exatech/contracts';
import { Can, Endpoint, Input, type Args } from '../../core/http';
import { AssignmentsService } from './assignments.service';
import { AttendanceService } from './attendance.service';
import { TeachingMarksService } from './marks.service';
import { TeachingMaterialsService } from './materials.service';
import { TodayService } from './today.service';

const ok = { ok: true as const };

@Controller()
export class TeachingTodayController {
  constructor(private readonly today: TodayService) {}

  @Endpoint(teachingTodayContract.today)
  @Can('teaching:attendance.mark')
  async get() {
    return this.today.today();
  }

  @Endpoint(teachingLeaveContract.impact)
  @Can('teaching:leave.request')
  async impact(@Input() { query }: Args<typeof teachingLeaveContract.impact>) {
    return this.today.leaveImpact(query.date);
  }

  @Endpoint(teachingLeaveContract.request)
  @Can('teaching:leave.request')
  async request(@Input() { body }: Args<typeof teachingLeaveContract.request>) {
    return this.today.requestLeave(body);
  }
}

@Controller()
export class TeachingAttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Endpoint(teachingAttendanceContract.get)
  @Can('teaching:attendance.mark')
  async get(@Input() { query }: Args<typeof teachingAttendanceContract.get>) {
    return this.attendance.get(query.session);
  }

  @Endpoint(teachingAttendanceContract.mark)
  @Can('teaching:attendance.mark')
  async mark(@Input() { params, body }: Args<typeof teachingAttendanceContract.mark>) {
    return this.attendance.mark(params.id, body.marks);
  }

  @Endpoint(teachingAttendanceContract.subject)
  @Can('teaching:attendance.mark')
  async subject(@Input() { params, body }: Args<typeof teachingAttendanceContract.subject>) {
    await this.attendance.setSubject(params.id, body.subject);
    return ok;
  }

  @Endpoint(teachingAttendanceContract.submit)
  @Can('teaching:attendance.mark')
  async submit(@Input() { params }: Args<typeof teachingAttendanceContract.submit>) {
    return this.attendance.submit(params.id);
  }

  @Endpoint(teachingAttendanceContract.qr)
  @Can('teaching:attendance.mark')
  async qr(@Input() { params }: Args<typeof teachingAttendanceContract.qr>) {
    return this.attendance.qr(params.id);
  }

  @Endpoint(teachingCoverContract.options)
  @Can('teaching:attendance.mark')
  async coverOptions() {
    return this.attendance.coverOptions();
  }

  @Endpoint(teachingCoverContract.start)
  @Can('teaching:attendance.mark')
  async cover(@Input() { body }: Args<typeof teachingCoverContract.start>) {
    return this.attendance.startCover(body);
  }
}

/** Student portal: QR self check-in (code shown by the teacher). */
@Controller()
export class CheckinController {
  constructor(private readonly attendance: AttendanceService) {}

  @Endpoint(checkinContract.checkIn)
  @Can('portal:student')
  async checkIn(@Input() { body }: Args<typeof checkinContract.checkIn>) {
    return this.attendance.checkIn(body.code);
  }
}

@Controller()
export class TeachingAssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Endpoint(teachingAssignmentsContract.list)
  @Can('teaching:assignments.manage')
  async list(@Input() { query }: Args<typeof teachingAssignmentsContract.list>) {
    return this.assignments.list(query.batchId);
  }

  @Endpoint(teachingAssignmentsContract.create)
  @Can('teaching:assignments.manage')
  async create(@Input() { body }: Args<typeof teachingAssignmentsContract.create>) {
    return this.assignments.create(body);
  }

  @Endpoint(teachingAssignmentsContract.grading)
  @Can('teaching:assignments.manage')
  async grading(@Input() { params }: Args<typeof teachingAssignmentsContract.grading>) {
    return this.assignments.grading(params.id);
  }

  @Endpoint(teachingAssignmentsContract.file)
  @Can('teaching:assignments.manage')
  async file(@Input() { params }: Args<typeof teachingAssignmentsContract.file>) {
    return this.assignments.fileUrl(params.id);
  }

  @Endpoint(teachingAssignmentsContract.grade)
  @Can('teaching:assignments.manage')
  async grade(@Input() { params, body }: Args<typeof teachingAssignmentsContract.grade>) {
    return this.assignments.grade(params.id, body.grades);
  }

  @Endpoint(teachingAssignmentsContract.remind)
  @Can('teaching:assignments.manage')
  async remind(@Input() { params }: Args<typeof teachingAssignmentsContract.remind>) {
    return this.assignments.remind(params.id);
  }

  @Endpoint(teachingAssignmentsContract.extend)
  @Can('teaching:assignments.manage')
  async extend(@Input() { params, body }: Args<typeof teachingAssignmentsContract.extend>) {
    await this.assignments.extend(params.id, body.dueDate, body.dueTime);
    return ok;
  }
}

@Controller()
export class TeachingMaterialsController {
  constructor(private readonly materials: TeachingMaterialsService) {}

  @Endpoint(teachingMaterialsContract.list)
  @Can('teaching:materials.manage')
  async list(@Input() { query }: Args<typeof teachingMaterialsContract.list>) {
    return this.materials.list(query.batchId);
  }

  @Endpoint(teachingMaterialsContract.upload)
  @Can('teaching:materials.manage')
  async upload(@Input() { body }: Args<typeof teachingMaterialsContract.upload>) {
    return this.materials.upload(body);
  }

  @Endpoint(teachingMaterialsContract.visibility)
  @Can('teaching:materials.manage')
  async visibility(@Input() { params, body }: Args<typeof teachingMaterialsContract.visibility>) {
    await this.materials.setVisibility(params.id, body.visibility, body.releaseOn);
    return ok;
  }

  @Endpoint(teachingMaterialsContract.remove)
  @Can('teaching:materials.delete', 'teaching:materials.manage')
  async remove(@Input() { params }: Args<typeof teachingMaterialsContract.remove>) {
    await this.materials.remove(params.id);
    return ok;
  }

  @Endpoint(teachingMaterialsContract.restore)
  @Can('teaching:materials.delete', 'teaching:materials.manage')
  async restore(@Input() { params }: Args<typeof teachingMaterialsContract.restore>) {
    await this.materials.restore(params.id);
    return ok;
  }
}

@Controller()
export class TeachingMarksController {
  constructor(private readonly marks: TeachingMarksService) {}

  @Endpoint(teachingMarksContract.exams)
  @Can('teaching:marks.enter')
  async exams() {
    return this.marks.exams();
  }

  @Endpoint(teachingMarksContract.exam)
  @Can('teaching:marks.enter')
  async exam(@Input() { params }: Args<typeof teachingMarksContract.exam>) {
    return this.marks.exam(params.id);
  }

  @Endpoint(teachingMarksContract.create)
  @Can('teaching:marks.enter')
  async create(@Input() { body }: Args<typeof teachingMarksContract.create>) {
    return this.marks.create(body);
  }

  @Endpoint(teachingMarksContract.save)
  @Can('teaching:marks.enter')
  async save(@Input() { params, body }: Args<typeof teachingMarksContract.save>) {
    return this.marks.save(params.id, body.cells);
  }

  @Endpoint(teachingMarksContract.fillZero)
  @Can('teaching:marks.enter')
  async fillZero(@Input() { params }: Args<typeof teachingMarksContract.fillZero>) {
    return this.marks.fillZero(params.id);
  }

  @Endpoint(teachingMarksContract.importCsv)
  @Can('teaching:marks.enter')
  async importCsv(@Input() { params, body }: Args<typeof teachingMarksContract.importCsv>) {
    return this.marks.importCsv(params.id, body.csv, body.dryRun);
  }

  @Endpoint(teachingMarksContract.submit)
  @Can('teaching:marks.enter')
  async submit(@Input() { params }: Args<typeof teachingMarksContract.submit>) {
    await this.marks.submit(params.id);
    return ok;
  }

  @Endpoint(teachingMarksContract.recall)
  @Can('teaching:marks.enter')
  async recall(@Input() { params }: Args<typeof teachingMarksContract.recall>) {
    await this.marks.recall(params.id);
    return ok;
  }
}
