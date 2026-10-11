import { Module } from '@nestjs/common';

/**
 * Academics bounded context. Owns its controllers, services and event handlers.
 * Reads other contexts' tables only through queries; never writes them —
 * integration happens through domain events (see core/events/event-bus.ts).
 */
@Module({
  controllers: [],
  providers: [],
})
export class AcademicsModule {}
