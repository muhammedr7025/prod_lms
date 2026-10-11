import { Controller } from '@nestjs/common';
import { institutionBranchesContract, institutionRolesContract, institutionSettingsContract, institutionStaffContract } from '@exatech/contracts';
import { Can, Endpoint, Input, type Args } from '../../core/http';
import { BranchesService } from './branches.service';
import { RolesService } from './roles.service';
import { SettingsService } from './settings.service';
import { StaffService } from './staff.service';

/** Branches, rooms and the holiday calendar. */
@Controller()
export class InstitutionBranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Endpoint(institutionBranchesContract.list)
  @Can('institution:branches.read')
  list() {
    return this.branches.list();
  }

  @Endpoint(institutionBranchesContract.get)
  @Can('institution:branches.read')
  get(@Input() { params }: Args<typeof institutionBranchesContract.get>) {
    return this.branches.get(params.id);
  }

  @Endpoint(institutionBranchesContract.create)
  @Can('institution:branches.manage')
  create(@Input() { body }: Args<typeof institutionBranchesContract.create>) {
    return this.branches.create(body);
  }

  @Endpoint(institutionBranchesContract.update)
  @Can('institution:branches.manage')
  update(@Input() { params, body }: Args<typeof institutionBranchesContract.update>) {
    return this.branches.update(params.id, body);
  }

  @Endpoint(institutionBranchesContract.addRoom)
  @Can('institution:branches.manage')
  addRoom(@Input() { params, body }: Args<typeof institutionBranchesContract.addRoom>) {
    return this.branches.addRoom(params.id, body);
  }

  @Endpoint(institutionBranchesContract.updateRoom)
  @Can('institution:branches.manage')
  updateRoom(@Input() { params, body }: Args<typeof institutionBranchesContract.updateRoom>) {
    return this.branches.updateRoom(params.id, body);
  }

  @Endpoint(institutionBranchesContract.holidays)
  @Can('institution:branches.read')
  holidays() {
    return this.branches.holidays();
  }

  @Endpoint(institutionBranchesContract.addHoliday)
  @Can('institution:branches.manage')
  addHoliday(@Input() { body }: Args<typeof institutionBranchesContract.addHoliday>) {
    return this.branches.addHoliday(body);
  }

  @Endpoint(institutionBranchesContract.removeHoliday)
  @Can('institution:branches.manage')
  removeHoliday(@Input() { params }: Args<typeof institutionBranchesContract.removeHoliday>) {
    return this.branches.removeHoliday(params.id);
  }
}

/** Staff & teachers: directory, invites, memberships, teaching assignments, leave, deactivation. */
@Controller()
export class InstitutionStaffController {
  constructor(private readonly staff: StaffService) {}

  @Endpoint(institutionStaffContract.list)
  @Can('institution:staff.read')
  list() {
    return this.staff.list();
  }

  @Endpoint(institutionStaffContract.options)
  @Can('institution:staff.manage')
  options() {
    return this.staff.options();
  }

  @Endpoint(institutionStaffContract.leave)
  @Can('institution:staff.read')
  leave() {
    return this.staff.leaveCalendar();
  }

  @Endpoint(institutionStaffContract.get)
  @Can('institution:staff.read')
  get(@Input() { params }: Args<typeof institutionStaffContract.get>) {
    return this.staff.get(params.id);
  }

  @Endpoint(institutionStaffContract.invite)
  @Can('institution:staff.manage')
  invite(@Input() { body }: Args<typeof institutionStaffContract.invite>) {
    return this.staff.invite(body);
  }

  @Endpoint(institutionStaffContract.setMemberships)
  @Can('institution:staff.manage')
  setMemberships(@Input() { params, body }: Args<typeof institutionStaffContract.setMemberships>) {
    return this.staff.setMemberships(params.id, body.memberships);
  }

  @Endpoint(institutionStaffContract.assign)
  @Can('institution:staff.manage')
  assign(@Input() { params, body }: Args<typeof institutionStaffContract.assign>) {
    return this.staff.assign(params.id, body);
  }

  @Endpoint(institutionStaffContract.recordLeave)
  @Can('institution:staff.manage')
  recordLeave(@Input() { params, body }: Args<typeof institutionStaffContract.recordLeave>) {
    return this.staff.recordLeave(params.id, body);
  }

  @Endpoint(institutionStaffContract.setStatus)
  @Can('institution:staff.manage')
  setStatus(@Input() { params, body }: Args<typeof institutionStaffContract.setStatus>) {
    return this.staff.setStatus(params.id, body);
  }

  @Endpoint(institutionStaffContract.signOutEverywhere)
  @Can('institution:staff.manage')
  signOut(@Input() { params }: Args<typeof institutionStaffContract.signOutEverywhere>) {
    return this.staff.signOutEverywhere(params.id);
  }
}

/** Roles & permissions matrix. */
@Controller()
export class InstitutionRolesController {
  constructor(private readonly roles: RolesService) {}

  @Endpoint(institutionRolesContract.list)
  @Can('institution:roles.manage')
  list() {
    return this.roles.list();
  }

  @Endpoint(institutionRolesContract.create)
  @Can('institution:roles.manage')
  create(@Input() { body }: Args<typeof institutionRolesContract.create>) {
    return this.roles.create(body);
  }

  @Endpoint(institutionRolesContract.saveMatrix)
  @Can('institution:roles.manage')
  save(@Input() { body }: Args<typeof institutionRolesContract.saveMatrix>) {
    return this.roles.saveMatrix(body.changes);
  }

  @Endpoint(institutionRolesContract.remove)
  @Can('institution:roles.manage')
  remove(@Input() { params }: Args<typeof institutionRolesContract.remove>) {
    return this.roles.remove(params.id);
  }
}

/** Institution settings. */
@Controller()
export class InstitutionSettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Endpoint(institutionSettingsContract.get)
  @Can('institution:settings.read', 'institution:settings.manage')
  get() {
    return this.settings.get();
  }

  @Endpoint(institutionSettingsContract.save)
  @Can('institution:settings.manage')
  save(@Input() { body }: Args<typeof institutionSettingsContract.save>) {
    return this.settings.save(body);
  }
}
