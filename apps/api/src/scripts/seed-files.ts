import '../config/load-env';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import * as s from '@exatech/db';
import { eq } from '@exatech/db';
import { Module } from '@nestjs/common';
import { DbModule, Db } from '../core/db';
import { DocumentKit } from '../core/documents/document-kit';
import { FilesService } from '../core/files/files.service';

@Module({ imports: [DbModule], providers: [FilesService] })
class SeedFilesModule {}

/**
 * Generates real files for seeded study material (PDFs with content, small
 * ZIP/XLSX placeholders) so downloads, signed URLs and watermarking work in
 * development. Safe to re-run: existing objects are skipped.
 */
async function main() {
  const app = await NestFactory.createApplicationContext(SeedFilesModule, { logger: ['error', 'warn'] });
  const files = app.get(FilesService);
  await files.onModuleInit();
  const db = app.get(Db);
  const rows = await db.db
    .select({ id: s.fileObject.id, key: s.fileObject.key, mime: s.fileObject.mime, filename: s.fileObject.filename, title: s.material.title, module: s.material.module, meta: s.material.meta })
    .from(s.fileObject)
    .leftJoin(s.material, eq(s.material.fileId, s.fileObject.id))
    .where(eq(s.fileObject.purpose, 'material'));
  let created = 0;
  for (const r of rows) {
    if (await files.exists(r.key)) continue;
    let body: Buffer;
    if (r.mime === 'application/pdf') {
      const kit = await DocumentKit.create('A4', { title: r.title ?? r.filename });
      kit.header({ institution: 'Exatech', title: 'Study material', date: new Date().toISOString().slice(0, 10) });
      kit.text(r.title ?? r.filename, { heading: true, size: 22 }).gap(4);
      kit.text(`${r.module ?? ''} · ${r.meta ?? ''}`, { size: 10 }).gap(10);
      for (let i = 1; i <= 6; i++) {
        kit.text(`Section ${i}`, { bold: true, size: 12 }).gap(2);
        kit
          .text(
            'This document is part of the course material for your batch. It is provided for your personal study only and is watermarked with your name when opened from the student portal. Sharing it outside the institute is not permitted.',
            { size: 10 },
          )
          .gap(8);
      }
      kit.footer('Exatech · course material · confidential');
      body = await kit.save();
    } else {
      // Minimal valid ZIP container (also what an empty XLSX starts as).
      body = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
    }
    await files.put(r.key, body, r.mime);
    await db.db.update(s.fileObject).set({ size: body.length }).where(eq(s.fileObject.id, r.id));
    created++;
  }
  console.log(`✓ seed files: ${created} created, ${rows.length - created} already present`);
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
