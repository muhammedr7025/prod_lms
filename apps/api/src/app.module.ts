import { Module } from '@nestjs/common';
import { CoreModule } from './core/core.module';
import { AcademicsModule } from './modules/academics/academics.module';
import { CommsModule } from './modules/comms/comms.module';
import { FinanceModule } from './modules/finance/finance.module';
import { InstitutionModule } from './modules/institution/institution.module';
import { PortalModule } from './modules/portal/portal.module';
import { SalesModule } from './modules/sales/sales.module';
import { TeachingModule } from './modules/teaching/teaching.module';

/**
 * Modular monolith: one API + one worker from the same codebase. Each
 * bounded context below can be developed, tested and later extracted alone.
 */
@Module({
  imports: [CoreModule, InstitutionModule, AcademicsModule, CommsModule, SalesModule, FinanceModule, TeachingModule, PortalModule],
})
export class AppModule {}
