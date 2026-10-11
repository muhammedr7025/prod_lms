import { Controller } from '@nestjs/common';
import { commsContract } from '@exatech/contracts';
import { Can, Endpoint, Input, type Args } from '../../core/http';
import { AiDraftService } from './ai-draft.service';
import { AnnouncementsService } from './announcements.service';

const ok = { ok: true as const };

@Controller()
export class CommsController {
  constructor(
    private readonly announcements: AnnouncementsService,
    private readonly ai: AiDraftService,
  ) {}

  @Endpoint(commsContract.list)
  @Can('comms:announcements.manage')
  async list() {
    return this.announcements.list();
  }

  @Endpoint(commsContract.create)
  @Can('comms:announcements.manage')
  async create(@Input() { body }: Args<typeof commsContract.create>) {
    return this.announcements.create(body);
  }

  @Endpoint(commsContract.preview)
  @Can('comms:announcements.manage')
  async preview(@Input() { body }: Args<typeof commsContract.preview>) {
    return this.announcements.preview(body.audience);
  }

  @Endpoint(commsContract.draft)
  @Can('comms:announcements.manage')
  async draft(@Input() { body }: Args<typeof commsContract.draft>) {
    return this.ai.draft(body);
  }

  @Endpoint(commsContract.withdraw)
  @Can('comms:announcements.manage', 'comms:announcements.delete')
  async withdraw(@Input() { params }: Args<typeof commsContract.withdraw>) {
    await this.announcements.withdraw(params.id);
    return ok;
  }

  @Endpoint(commsContract.feed)
  @Can('comms:announcements.read')
  async feed() {
    return this.announcements.feed();
  }

  @Endpoint(commsContract.read)
  @Can('comms:announcements.read')
  async read(@Input() { params }: Args<typeof commsContract.read>) {
    await this.announcements.markRead(params.id);
    return ok;
  }

  @Endpoint(commsContract.ack)
  @Can('comms:announcements.read')
  async ack(@Input() { params }: Args<typeof commsContract.ack>) {
    await this.announcements.ack(params.id);
    return ok;
  }
}
