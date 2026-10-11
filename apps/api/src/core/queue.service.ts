import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type Job, type JobsOptions, type Processor } from 'bullmq';
import { env } from '../config/env';
import { RedisService } from './redis';

export type QueueName = 'imports' | 'reminders' | 'documents' | 'maintenance';

/**
 * BullMQ queues for slow work (imports, reminders, PDF generation, nightly
 * maintenance). Producers call `add()`; processors are registered by modules
 * with `process()` and only run in the worker process.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly log = new Logger('Queue');
  private readonly queues = new Map<QueueName, Queue>();
  private readonly processors = new Map<QueueName, { fn: Processor; concurrency: number }>();
  private readonly workers: Worker[] = [];

  constructor(private readonly redis: RedisService) {}

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.redis.bullConnection(), prefix: `${env().REDIS_PREFIX}:bull` });
      this.queues.set(name, q);
    }
    return q;
  }

  async add<T extends object>(name: QueueName, jobName: string, data: T, opts: JobsOptions = {}): Promise<Job<T>> {
    return this.queue(name).add(jobName, data, { removeOnComplete: 500, removeOnFail: 1000, attempts: 3, backoff: { type: 'exponential', delay: 5000 }, ...opts });
  }

  /** Register the processor for a queue (call from a module's onModuleInit). */
  process(name: QueueName, fn: Processor, concurrency = 2): void {
    this.processors.set(name, { fn, concurrency });
  }

  /** Start workers for every registered processor — worker process only. */
  startWorkers(): void {
    for (const [name, { fn, concurrency }] of this.processors) {
      const w = new Worker(name, fn, { connection: this.redis.bullConnection(), prefix: `${env().REDIS_PREFIX}:bull`, concurrency });
      w.on('failed', (job, err) => this.log.warn(`${name}/${job?.name} failed: ${err.message}`));
      this.workers.push(w);
      this.log.log(`worker started: ${name} ×${concurrency}`);
    }
  }

  async onModuleDestroy() {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
