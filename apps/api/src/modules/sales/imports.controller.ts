import { Controller, Param, Res } from '@nestjs/common';
import { salesContract } from '@exatech/contracts';
import * as s from '@exatech/db';
import { eq, type ImportMapping } from '@exatech/db';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AuditService } from '../../core/audit/audit.service';
import { assertBranchAccess, can, ctx } from '../../core/context';
import { Db } from '../../core/db';
import { conflict, forbidden, invalid, notFound } from '../../core/errors';
import { FilesService } from '../../core/files/files.service';
import { Can, Endpoint, Input, type Args } from '../../core/http';
import { ImportsService, guessTarget } from './imports.service';
import { csvEscape, resolveBranchId } from './sales.shared';

@Controller()
export class ImportsController {
  constructor(
    private readonly db: Db,
    private readonly imports: ImportsService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
  ) {}

  private async job(id: string) {
    const [job] = await this.db.db.select().from(s.leadImportJob).where(eq(s.leadImportJob.id, id));
    if (!job) throw notFound('Import');
    const c = ctx();
    assertBranchAccess(job.branchId);
    if (job.createdBy !== c.userId && !can('sales:leads.all')) throw forbidden('This import belongs to another salesperson');
    return job;
  }

  @Endpoint(salesContract.createImport)
  @Can('sales:import')
  async create(@Input() { body }: Args<typeof salesContract.createImport>) {
    const c = ctx();
    const f = await this.files.get(body.fileId);
    if (f.purpose !== 'import') throw invalid('Upload the file as a lead import');
    if (f.ownerUserId !== c.userId) throw forbidden('Upload the file yourself to import it');
    const parsed = await this.imports.parse(f.id);
    const mapping: ImportMapping = {};
    const used = new Set<string>();
    for (const h of parsed.headers) {
      let t = guessTarget(h);
      // One source column per field; later duplicates are skipped.
      if (t !== 'skip' && used.has(t)) t = 'skip';
      used.add(t);
      mapping[h] = t;
    }
    const branchId = await resolveBranchId(this.db.db);
    assertBranchAccess(branchId);
    const job = await this.db.tx(async (tx) => {
      const [row] = await tx
        .insert(s.leadImportJob)
        .values({ branchId, createdBy: c.userId, filename: f.filename, fileId: f.id, headers: parsed.headers, mapping, totalRows: parsed.rows.length, status: 'uploaded' })
        .returning();
      await this.audit.log(tx, { action: 'Lead import uploaded', kind: 'create', entityType: 'lead_import_job', entityId: row!.id, entityLabel: f.filename, summary: `${f.filename} · ${parsed.rows.length} rows`, branchId });
      return row!;
    });
    return this.imports.view(job, parsed.rows.slice(0, 50));
  }

  @Endpoint(salesContract.getImport)
  @Can('sales:import')
  async get(@Input() { params }: Args<typeof salesContract.getImport>) {
    return this.imports.view(await this.job(params.id));
  }

  @Endpoint(salesContract.validateImport)
  @Can('sales:import')
  async validate(@Input() { params, body }: Args<typeof salesContract.validateImport>) {
    const job = await this.job(params.id);
    if (job.status !== 'uploaded' && job.status !== 'validated') throw conflict('This import has already run');
    for (const k of Object.keys(body.mapping)) if (!job.headers.includes(k)) throw invalid(`Unknown column "${k}"`);
    const mapping: ImportMapping = Object.fromEntries(job.headers.map((h) => [h, body.mapping[h] ?? 'skip']));
    const targets = Object.values(mapping).filter((t) => t !== 'skip');
    if (new Set(targets).size !== targets.length) throw invalid('Each field can be mapped from one column only', { mapping: 'Duplicate mapping' });
    const parsed = await this.imports.parse(job.fileId!);
    const result = await this.imports.check(this.db.db, ctx().institutionId, parsed, mapping);
    const [updated] = await this.db.db
      .update(s.leadImportJob)
      .set({
        mapping,
        status: 'validated',
        totalRows: parsed.rows.length,
        validRows: result.counts.valid,
        duplicateRows: result.counts.duplicates,
        duplicateLeads: result.counts.duplicateLeads,
        duplicateStudents: result.counts.duplicateStudents,
        invalidRows: result.counts.invalid,
        errors: result.errors,
      })
      .where(eq(s.leadImportJob.id, job.id))
      .returning();
    return this.imports.view(updated!, parsed.rows.slice(0, 50));
  }

  @Endpoint(salesContract.runImport)
  @Can('sales:import')
  async run(@Input() { params, body }: Args<typeof salesContract.runImport>) {
    const job = await this.job(params.id);
    if (job.status !== 'validated') throw conflict(job.status === 'uploaded' ? 'Validate the file before running the import' : 'This import has already been started');
    const updated = await this.db.tx(async (tx) => {
      const [row] = await tx.update(s.leadImportJob).set({ status: 'queued', dupStrategy: body.dupStrategy, progress: 0 }).where(eq(s.leadImportJob.id, job.id)).returning();
      await this.audit.log(tx, {
        action: 'Lead import started',
        kind: 'create',
        entityType: 'lead_import_job',
        entityId: job.id,
        entityLabel: job.filename,
        summary: `${job.filename} · ${job.validRows} new · ${job.duplicateRows} duplicates (${body.dupStrategy}) · ${job.invalidRows} invalid`,
        branchId: job.branchId,
      });
      return row!;
    });
    await this.imports.enqueue(job.id);
    return this.imports.view(updated);
  }

  /** Downloadable error report (CSV). */
  @Endpoint({ method: 'GET', path: salesContract.importErrorsPath, response: z.any() })
  @Can('sales:import')
  async errors(@Param('id') id: string, @Res() reply: FastifyReply) {
    const job = await this.job(id);
    const lines = [['row', 'field', 'problem', 'value'].join(','), ...(job.errors ?? []).map((e) => [e.row, e.field, e.message, e.value ?? ''].map(csvEscape).join(','))];
    void reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="import-errors-${job.filename.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_')}.csv"`)
      .send(lines.join('\n'));
  }

  /** Template with the columns the mapper recognises. */
  @Endpoint({ method: 'GET', path: salesContract.importTemplatePath, response: z.any() })
  @Can('sales:import')
  async template(@Res() reply: FastifyReply) {
    const lines = ['Full Name,Mobile,Email ID,Interested In,Campaign,City', 'Anu Joseph,9847011223,anu.j@gmail.com,Digital Marketing,IG_Oct_A,Trivandrum'];
    void reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="leads-template.csv"').send(lines.join('\n'));
  }
}
