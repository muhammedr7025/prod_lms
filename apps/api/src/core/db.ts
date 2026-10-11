import { Global, Inject, Injectable, Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import { createDb, inArray, sql, type AnyColumn, type Database, type DbHandle, type DbOrTx, type SQL, type Tx } from '@exatech/db';
import { env } from '../config/env';
import { branchScope } from './context';

export const DB_HANDLE = Symbol('DB_HANDLE');

const pending = new WeakMap<object, (() => unknown)[]>();
const log = new Logger('Db');

/**
 * Run `fn` after the surrounding transaction commits (realtime pushes, cache
 * invalidation). Outside a `Db.tx` transaction it runs on the next tick.
 */
export function afterCommit(tx: DbOrTx, fn: () => unknown): void {
  const list = pending.get(tx);
  if (list) list.push(fn);
  else
    void Promise.resolve()
      .then(fn)
      .catch((err) => log.warn(`afterCommit callback failed: ${(err as Error).message}`));
}

@Injectable()
export class Db implements OnModuleDestroy {
  readonly db: Database;
  readonly sql: DbHandle['sql'];

  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {
    this.db = handle.db;
    this.sql = handle.sql;
  }

  /**
   * Run in a transaction. Always use this (not db.transaction) so that
   * `afterCommit` callbacks fire once the transaction has committed.
   */
  async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    let callbacks: (() => unknown)[] = [];
    const result = await this.db.transaction(async (t) => {
      callbacks = [];
      pending.set(t, callbacks);
      return fn(t);
    });
    for (const cb of callbacks) {
      try {
        await cb();
      } catch (err) {
        log.warn(`afterCommit callback failed: ${(err as Error).message}`);
      }
    }
    return result;
  }

  async onModuleDestroy() {
    await this.handle.close();
  }
}

@Global()
@Module({
  providers: [{ provide: DB_HANDLE, useFactory: () => createDb(env().DATABASE_URL, { max: 15 }) }, Db],
  exports: [Db],
})
export class DbModule {}

/**
 * Repository helper: restrict a query to the current branch scope.
 * Returns undefined when unrestricted so it can be spread into `and(...)`.
 */
export function inBranchScope(column: AnyColumn): SQL | undefined {
  const scope = branchScope();
  if (scope === null) return undefined;
  if (scope.length === 0) return sql`false`;
  return inArray(column, scope);
}

export type { Tx, DbOrTx };
