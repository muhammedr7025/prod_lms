import { Injectable } from '@nestjs/common';
import { sql, type Tx } from '@exatech/db';

/**
 * Gap-free sequences. The counter row is locked in the same transaction that
 * writes the document, so a rolled-back transaction never burns a number.
 */
@Injectable()
export class NumberingService {
  async next(tx: Tx, scopeId: string, docType: string, period: string): Promise<number> {
    await tx.execute(sql`insert into doc_sequence (scope_id, doc_type, period, next_seq) values (${scopeId}, ${docType}, ${period}, 1) on conflict do nothing`);
    const rows = await tx.execute<{ next_seq: number }>(
      sql`select next_seq from doc_sequence where scope_id = ${scopeId} and doc_type = ${docType} and period = ${period} for update`,
    );
    const seq = Number(rows[0]!.next_seq);
    await tx.execute(sql`update doc_sequence set next_seq = next_seq + 1 where scope_id = ${scopeId} and doc_type = ${docType} and period = ${period}`);
    return seq;
  }

  /** Peek without consuming (for previews). */
  async peek(tx: Tx, scopeId: string, docType: string, period: string): Promise<number> {
    const rows = await tx.execute<{ next_seq: number }>(sql`select next_seq from doc_sequence where scope_id = ${scopeId} and doc_type = ${docType} and period = ${period}`);
    return rows[0] ? Number(rows[0].next_seq) : 1;
  }
}
