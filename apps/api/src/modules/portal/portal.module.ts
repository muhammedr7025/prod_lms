import { Module } from '@nestjs/common';
import { FinanceModule } from '../finance/finance.module';
import { FeesService } from './fees.service';
import { HomeService } from './home.service';
import { MarksService } from './marks.service';
import { NotesService } from './notes.service';
import { ParentService } from './parent.service';
import { PortalController } from './portal.controller';
import { PortalShared } from './portal.shared';
import { TimetableService } from './timetable.service';
import { WorkService } from './work.service';

/**
 * Portal bounded context: the backend-for-frontend of the student and parent
 * portals. Reads other contexts' tables (scoped through ScopeService) and
 * writes only the documented student-owned rows: submissions, material
 * access log, parent messages and PTM requests. Payments go through Finance
 * (paymentsContract), announcements through Comms, QR check-in through
 * Teaching. Fee arithmetic reuses Finance's exported FinanceShared + ledger.
 */
@Module({
  imports: [FinanceModule],
  controllers: [PortalController],
  providers: [PortalShared, HomeService, TimetableService, NotesService, WorkService, MarksService, FeesService, ParentService],
})
export class PortalModule {}
