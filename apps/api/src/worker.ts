import './config/load-env';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { BackgroundService } from './core/worker/background.service';

/**
 * Worker process: same codebase as the API, no HTTP. Runs the outbox relay,
 * the message dispatcher and the BullMQ processors.
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  app.enableShutdownHooks();
  await app.get(BackgroundService).start();
  Logger.log('Worker running', 'Bootstrap');
}

void bootstrap();
