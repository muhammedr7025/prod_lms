import { Controller, Post, Req } from '@nestjs/common';
import { filesContract, FILE_PURPOSES, type FileRef } from '@exatech/contracts';
import type { FastifyRequest } from 'fastify';
import { ctx } from '../context';
import { Db } from '../db';
import { badRequest, forbidden } from '../errors';
import { Endpoint, Input, type Args } from '../http';
import { FilesService, MAX_UPLOAD_BYTES } from './files.service';

const STAFF_ONLY = new Set(['material', 'admission_doc', 'import', 'statement', 'logo']);

@Controller()
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly db: Db,
  ) {}

  /** multipart/form-data upload: field "file", query ?purpose= */
  @Post(filesContract.uploadPath)
  async upload(@Req() req: FastifyRequest): Promise<FileRef> {
    const purpose = String((req.query as Record<string, string>)?.purpose ?? '');
    if (!(FILE_PURPOSES as readonly string[]).includes(purpose)) throw badRequest('Unknown upload purpose');
    const c = ctx();
    if (c.readOnly) throw forbidden('Read-only session');
    if (STAFF_ONLY.has(purpose) && c.userKind !== 'staff') throw forbidden();
    if (!req.isMultipart()) throw badRequest('Expected a multipart upload');
    const part = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
    if (!part) throw badRequest('No file received');
    const buffer = await part.toBuffer();
    if (part.file.truncated) throw badRequest('File is too large');
    const row = await this.files.store(this.db.db, { buffer, filename: part.filename, purpose, ownerUserId: c.userId });
    return { id: row.id, filename: row.filename, mime: row.mime, size: row.size };
  }

  /** Owner (or staff) can get a 5-minute URL for an uploaded file. Domain modules gate their own files. */
  @Endpoint(filesContract.signedUrl)
  async signedUrl(@Input() { params }: Args<typeof filesContract.signedUrl>) {
    const c = ctx();
    const f = await this.files.get(params.id);
    if (f.ownerUserId !== c.userId && c.userKind !== 'staff') throw forbidden();
    return this.files.signedUrl(f.id);
  }
}
