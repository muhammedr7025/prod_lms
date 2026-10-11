import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AccessService } from './auth/access.service';
import { AuthGuard, ContextInterceptor } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { TwoFactorController } from './auth/two-factor.controller';
import { DbModule } from './db';
import { DevController } from './dev.controller';
import { EventBus } from './events/event-bus';
import { FilesController } from './files/files.controller';
import { FilesService } from './files/files.service';
import { HealthController } from './health.controller';
import { AllExceptionsFilter, ResponseContractInterceptor } from './http';
import { MeController } from './me/me.controller';
import { MessagingService } from './messaging/messaging.service';
import { NotificationsController } from './notifications/notifications.controller';
import { NotifyService } from './notifications/notify.service';
import { NumberingService } from './numbering.service';
import { PublicController } from './public.controller';
import { QueueService } from './queue.service';
import { RealtimeController } from './realtime/realtime.controller';
import { RealtimeService } from './realtime/realtime.service';
import { RedisModule } from './redis';
import { ReferenceController } from './reference.controller';
import { ScopeService } from './scope.service';
import { SearchController } from './search.controller';
import { BackgroundService } from './worker/background.service';

const SERVICES = [
  AuthService,
  AccessService,
  AuditService,
  EventBus,
  FilesService,
  MessagingService,
  NotifyService,
  NumberingService,
  QueueService,
  RealtimeService,
  ScopeService,
  BackgroundService,
];

/** Platform services every feature module may inject (global). */
@Global()
@Module({
  imports: [DbModule, RedisModule],
  controllers: [
    HealthController,
    PublicController,
    MeController,
    TwoFactorController,
    ReferenceController,
    NotificationsController,
    SearchController,
    AuditController,
    FilesController,
    RealtimeController,
    DevController,
  ],
  providers: [
    ...SERVICES,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: ContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseContractInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
  exports: [...SERVICES, DbModule, RedisModule],
})
export class CoreModule {}
