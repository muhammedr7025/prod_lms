import { Module } from '@nestjs/common';
import { BranchesService } from './branches.service';
import { InstitutionBranchesController, InstitutionRolesController, InstitutionSettingsController, InstitutionStaffController } from './institution.controller';
import { MetricsService } from './metrics.service';
import { InstitutionOverviewController } from './overview.controller';
import { RolesService } from './roles.service';
import { SettingsService } from './settings.service';
import { StaffService } from './staff.service';

/**
 * Institution bounded context — the Super Admin's workspace: overview KPIs
 * (materialised per branch scope for 60 s), branches / rooms / holidays,
 * staff & teachers (memberships = role × scope, invites, teaching
 * assignments, leave on behalf, deactivation), roles & permissions and
 * institution settings.
 *
 * System of record for institution, branch, room, holiday, role, membership,
 * staff_profile and staff users. Reads Academics, Sales and Finance tables
 * for KPIs. Documented writes outside it: class_session.status when a
 * holiday is added/removed (suppressed ↔ scheduled, SessionUpdated emitted),
 * class_session.flag + leave when leave is recorded on someone's behalf
 * (LeaveDecided emitted), and teacher_assignment from "Assign to batch".
 * Approval effects stay with the owning modules (ApprovalDecided).
 */
@Module({
  controllers: [InstitutionOverviewController, InstitutionBranchesController, InstitutionStaffController, InstitutionRolesController, InstitutionSettingsController],
  providers: [MetricsService, BranchesService, StaffService, RolesService, SettingsService],
})
export class InstitutionModule {}
