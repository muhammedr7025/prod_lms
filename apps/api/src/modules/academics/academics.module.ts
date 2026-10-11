import { Module } from '@nestjs/common';
import { BatchesController, IdCardsController, MarksController, MaterialsController, OverviewController, StudentsController, TimetableController } from './academics.controller';
import { AcademicsShared } from './academics.shared';
import { BatchesService } from './batches.service';
import { CardTokens } from './card-tokens';
import { IdCardsService } from './id-cards.service';
import { StudentImportService } from './import.service';
import { MarksService } from './marks.service';
import { MaterialsService } from './materials.service';
import { OverviewService } from './overview.service';
import { StudentsService } from './students.service';
import { TimetableService } from './timetable.service';

/**
 * Academics bounded context (Branch Administrator): branch operations,
 * courses & batches, timetable, students, notes oversight and marks
 * publishing. Owns batch / teacher_assignment / class_session (timetable
 * columns) / leave decisions / enrollment transfers; publishes and returns
 * exams (documented exception). Integration with other contexts is through
 * domain events (Session*, SubstituteAssigned, LeaveDecided, BatchTransferred,
 * Marks*, Material*).
 */
@Module({
  controllers: [OverviewController, BatchesController, TimetableController, StudentsController, IdCardsController, MaterialsController, MarksController],
  providers: [AcademicsShared, CardTokens, TimetableService, OverviewService, BatchesService, StudentsService, StudentImportService, IdCardsService, MaterialsService, MarksService],
  exports: [CardTokens, AcademicsShared],
})
export class AcademicsModule {}
