import './config/load-env';
import 'reflect-metadata';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { env } from './config/env';
import { AuthService } from './core/auth/auth.service';
import { BackgroundService } from './core/worker/background.service';
import { MAX_UPLOAD_BYTES } from './core/files/files.service';

async function bootstrap() {
  const e = env();
  const adapter = new FastifyAdapter({ trustProxy: true, bodyLimit: 2 * 1024 * 1024, logger: false });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: e.LOG_LEVEL === 'debug' ? ['error', 'warn', 'log', 'debug'] : ['error', 'warn', 'log'],
    bufferLogs: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false, // API only serves JSON; the web app sets the page CSP
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

  // Better Auth lives at /api/auth/* on the same origin as the web app (Next rewrites /api).
  const auth = app.get(AuthService).auth;
  const fastify = app.getHttpAdapter().getInstance();
  fastify.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (request, reply) => {
      const url = new URL(request.url, e.WEB_ORIGIN);
      const headers = new Headers();
      for (const [k, v] of Object.entries(request.headers)) if (v) headers.append(k, Array.isArray(v) ? v.join(', ') : String(v));
      const req = new Request(url.toString(), {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body ? JSON.stringify(request.body) : undefined,
      });
      const res = await auth.handler(req);
      reply.status(res.status);
      res.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'set-cookie') reply.header(key, value);
      });
      const cookies = res.headers.getSetCookie?.() ?? [];
      if (cookies.length) reply.header('set-cookie', cookies);
      const text = await res.text();
      return reply.send(text.length ? text : null);
    },
  });

  app.enableShutdownHooks();
  await app.listen({ port: e.API_PORT, host: '0.0.0.0' });
  Logger.log(`API listening on :${e.API_PORT} (web origin ${e.WEB_ORIGIN})`, 'Bootstrap');

  // Development convenience: run the worker loops in-process unless a separate worker runs.
  if (process.env.EMBED_WORKER !== 'false' && e.NODE_ENV !== 'production') {
    await app.get(BackgroundService).start();
  }
}

void bootstrap();
