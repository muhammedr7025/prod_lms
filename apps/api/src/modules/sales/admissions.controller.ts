import { Controller } from '@nestjs/common';
import { admissionsContract, salesContract } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, eq, inArray, isNull, or, sql } from '@exatech/db';
import { formatDayMonth, todayIST } from '@exatech/domain';
import { ctx } from '../../core/context';
import { Db } from '../../core/db';
import { Can, Endpoint, Input, type Args } from '../../core/http';
import { AdmissionsService } from './admissions.service';

/** Implements `admissionsContract` (shared with Finance's verification UI) + the wizard's pickers. */
@Controller()
export class AdmissionsController {
  constructor(
    private readonly db: Db,
    private readonly admissions: AdmissionsService,
  ) {}

  @Endpoint(admissionsContract.list)
  @Can('admissions:read')
  async list(@Input() { query }: Args<typeof admissionsContract.list>) {
    return this.admissions.list(query.status);
  }

  @Endpoint(admissionsContract.get)
  @Can('admissions:read')
  async get(@Input() { params }: Args<typeof admissionsContract.get>) {
    return this.admissions.detail(this.db.db, params.id);
  }

  @Endpoint(admissionsContract.submit)
  @Can('admissions:create')
  async submit(@Input() { body }: Args<typeof admissionsContract.submit>) {
    const id = await this.admissions.save(body, null);
    return this.admissions.detail(this.db.db, id, false);
  }

  @Endpoint(admissionsContract.update)
  @Can('admissions:update')
  async update(@Input() { params, body }: Args<typeof admissionsContract.update>) {
    const id = await this.admissions.save(body, params.id);
    return this.admissions.detail(this.db.db, id, false);
  }

  @Endpoint(admissionsContract.verifyFee)
  @Can('admissions:verify_fee')
  async verifyFee(@Input() { params, body }: Args<typeof admissionsContract.verifyFee>) {
    await this.admissions.verifyFee(params.id, body.note);
    const [row] = await this.admissions.rows(this.db.db, eq(s.admission.id, params.id));
    return row!;
  }

  @Endpoint(admissionsContract.returnApp)
  @Can('admissions:verify_fee', 'admissions:approve')
  async returnApp(@Input() { params, body }: Args<typeof admissionsContract.returnApp>) {
    await this.admissions.returnApp(params.id, body.to, body.note);
    const [row] = await this.admissions.rows(this.db.db, eq(s.admission.id, params.id));
    return row!;
  }

  @Endpoint(admissionsContract.approve)
  @Can('admissions:approve')
  async approve(@Input() { params }: Args<typeof admissionsContract.approve>) {
    await this.admissions.approve(params.id);
    const [row] = await this.admissions.rows(this.db.db, eq(s.admission.id, params.id));
    return row!;
  }

  @Endpoint(admissionsContract.waitlist)
  @Can('admissions:approve')
  async waitlist(@Input() { params }: Args<typeof admissionsContract.waitlist>) {
    await this.admissions.waitlist(params.id);
    const [row] = await this.admissions.rows(this.db.db, eq(s.admission.id, params.id));
    return row!;
  }

  @Endpoint(admissionsContract.cancel)
  @Can('admissions:update', 'admissions:delete')
  async cancel(@Input() { params, body }: Args<typeof admissionsContract.cancel>) {
    await this.admissions.cancel(params.id, body.reason);
    return { ok: true as const };
  }

  /** Courses, batches with live seats (allowed branches), fee plans and discount thresholds for the wizard. */
  @Endpoint(salesContract.admissionOptions)
  @Can('admissions:create', 'admissions:update')
  async options() {
    const c = ctx();
    const db = this.db.db;
    const branchIds = c.membershipBranchIds;
    const branchWhere = branchIds ? inArray(s.batch.branchId, branchIds) : undefined;
    const [courses, batches, plans, thresholds] = await Promise.all([
      db.select({ id: s.course.id, code: s.course.code, name: s.course.name }).from(s.course).where(and(eq(s.course.institutionId, c.institutionId), eq(s.course.status, 'active'))).orderBy(asc(s.course.name)),
      db
        .select({
          id: s.batch.id,
          code: s.batch.code,
          branchId: s.batch.branchId,
          branchName: s.branch.name,
          courseId: s.batch.courseId,
          status: s.batch.status,
          capacity: s.batch.capacity,
          startDate: s.batch.startDate,
          scheduleLabel: s.batch.scheduleLabel,
          feePlanId: s.batch.feePlanId,
          teacher: sql<string | null>`(select u.name from teacher_assignment ta join "user" u on u.id = ta.teacher_user_id where ta.batch_id = ${s.batch.id} and ta.active order by ta.is_primary desc limit 1)`,
          enrolled: sql<number>`(select count(*)::int from enrollment e where e.batch_id = ${s.batch.id} and e.status = 'active')`,
          waitlisted: sql<number>`(select count(*)::int from admission a where a.batch_id = ${s.batch.id} and (a.status = 'waitlisted' or (a.waitlist and a.status in ('submitted','fee_verified'))))`,
        })
        .from(s.batch)
        .innerJoin(s.branch, eq(s.branch.id, s.batch.branchId))
        .where(and(inArray(s.batch.status, ['planned', 'open', 'running', 'waitlist']), branchWhere))
        .orderBy(asc(s.batch.startDate)),
      db
        .select()
        .from(s.feePlan)
        .where(and(eq(s.feePlan.institutionId, c.institutionId), eq(s.feePlan.active, true), branchIds ? or(isNull(s.feePlan.branchId), inArray(s.feePlan.branchId, branchIds)) : undefined))
        .orderBy(asc(s.feePlan.createdAt)),
      this.admissions.thresholds(),
    ]);
    const today = todayIST();
    return {
      today,
      thresholds,
      courses,
      batches: batches.map((b) => {
        const enrolled = Number(b.enrolled);
        const when = b.startDate > today ? `starts ${formatDayMonth(b.startDate)}` : 'running · join mid-course';
        return {
          id: b.id,
          code: b.code,
          branchId: b.branchId,
          branchName: b.branchName,
          courseId: b.courseId,
          status: b.status,
          capacity: b.capacity,
          enrolled,
          seatsLeft: b.capacity - enrolled,
          waitlisted: Number(b.waitlisted),
          line: [b.scheduleLabel, when, b.teacher].filter(Boolean).join(' · '),
          feePlanId: b.feePlanId,
        };
      }),
      plans: plans.map((p) => ({
        id: p.id,
        courseId: p.courseId,
        branchId: p.branchId,
        name: p.name,
        kind: p.kind,
        components: p.components,
        schedule: p.schedule,
        gstRate: p.gstRate,
        earlyPayDiscountPct: p.earlyPayDiscountPct,
        isDefault: p.isDefault,
      })),
    };
  }
}
