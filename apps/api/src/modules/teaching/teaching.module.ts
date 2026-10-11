import { Module } from '@nestjs/common';
import { AcademicsModule } from '../academics/academics.module';
import { AssignmentsService } from './assignments.service';
import { AttendanceService } from './attendance.service';
import { TeachingMarksService } from './marks.service';
import { TeachingMaterialsService } from './materials.service';
import {
  CheckinController,
  TeachingAssignmentsController,
  TeachingAttendanceController,
  TeachingMarksController,
  TeachingMaterialsController,
  TeachingTodayController,
} from './teaching.controller';
import { TeachingShared } from './teaching.shared';
import { TodayService } from './today.service';

/**
 * Teaching bounded context (the teacher's mobile-first workspace): Today,
 * attendance (incl. ad-hoc cover and QR self check-in), leave requests,
 * assignments & grading, notes & material, exams & marks entry.
 *
 * System of record for attendance, exam (draft → submitted, recall), mark,
 * assignment, submission grading and material. Writes the attendance columns
 * of class_session (documented shared table with Academics) and creates
 * ad-hoc / exam sessions. Attendance % uses Academics' exported
 * `recomputeBatchAttendance` so both contexts apply the same rule (ad-hoc
 * sessions count only once acknowledged).
 */
@Module({
  imports: [AcademicsModule],
  controllers: [TeachingTodayController, TeachingAttendanceController, CheckinController, TeachingAssignmentsController, TeachingMaterialsController, TeachingMarksController],
  providers: [TeachingShared, TodayService, AttendanceService, AssignmentsService, TeachingMaterialsService, TeachingMarksService],
})
export class TeachingModule {}
