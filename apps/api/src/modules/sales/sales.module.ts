import { Module } from '@nestjs/common';
import { AdmissionsController } from './admissions.controller';
import { AdmissionsService } from './admissions.service';
import { FollowUpsController } from './follow-ups.controller';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';
import { InsightsController } from './insights.controller';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { PublicLeadsController } from './public-leads.controller';
import { RulesController } from './rules.controller';

/**
 * Sales + Admissions bounded context. Owns leads, follow-ups, imports,
 * assignment rules, targets and the admission chain (system of record for
 * lead, lead_activity, follow_up, lead_import_job, assignment_rule,
 * sales_target, admission, admission_event; creates student/guardian/
 * enrollment rows on approval). Other contexts integrate through domain
 * events (AdmissionApproved, LeadStageChanged, …).
 */
@Module({
  controllers: [LeadsController, PublicLeadsController, FollowUpsController, RulesController, InsightsController, ImportsController, AdmissionsController],
  providers: [LeadsService, ImportsService, AdmissionsService],
})
export class SalesModule {}
