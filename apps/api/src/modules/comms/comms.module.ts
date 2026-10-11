import { Module } from '@nestjs/common';
import { AiDraftService } from './ai-draft.service';
import { AnnouncementsService } from './announcements.service';
import { AudienceService } from './audience.service';
import { CommsController } from './comms.controller';

/**
 * Comms bounded context: announcements (audience targeting, scheduling, pin,
 * acknowledgement, WhatsApp fan-out) and the per-user feed the portals read.
 * Owns announcement / announcement_recipient; emits AnnouncementPublished.
 */
@Module({
  controllers: [CommsController],
  providers: [AudienceService, AnnouncementsService, AiDraftService],
})
export class CommsModule {}
