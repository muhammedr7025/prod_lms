import { Controller, Get, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ctx } from '../context';
import { RealtimeService } from './realtime.service';

/**
 * GET /api/realtime/stream — one SSE connection per tab. Pushes notifications
 * and query invalidations (payments, publishes, attendance…).
 */
@Controller()
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService) {}

  @Get('/api/realtime/stream')
  stream(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const c = ctx();
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    raw.write(`retry: 5000\n\n`);
    raw.write(`event: ready\ndata: {}\n\n`);
    const branchScope = c.selectedBranchId ? [c.selectedBranchId] : c.membershipBranchIds;
    const off = this.realtime.listen(c.userId, branchScope, (msg) => {
      raw.write(`data: ${JSON.stringify(msg)}\n\n`);
    });
    const ping = setInterval(() => raw.write(`: ping\n\n`), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      off();
    });
  }
}
