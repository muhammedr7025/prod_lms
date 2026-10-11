import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import * as s from '@exatech/db';
import { eq, type DbOrTx } from '@exatech/db';
import crypto from 'node:crypto';
import { env } from '../../config/env';
import { Db } from '../db';
import { badRequest, notFound } from '../errors';

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

const ALLOWED: Record<string, { mimes: string[]; maxBytes: number }> = {
  material: { mimes: ['application/pdf', 'application/zip', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'image/png', 'image/jpeg', 'video/mp4'], maxBytes: MAX_UPLOAD_BYTES },
  submission: { mimes: ['application/pdf', 'application/zip', 'image/png', 'image/jpeg', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'text/plain'], maxBytes: 50 * 1024 * 1024 },
  admission_doc: { mimes: ['application/pdf', 'image/png', 'image/jpeg'], maxBytes: 10 * 1024 * 1024 },
  photo: { mimes: ['image/png', 'image/jpeg'], maxBytes: 5 * 1024 * 1024 },
  import: { mimes: ['text/csv', 'text/plain', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], maxBytes: 10 * 1024 * 1024 },
  statement: { mimes: ['application/pdf', 'text/csv', 'text/plain'], maxBytes: 10 * 1024 * 1024 },
  logo: { mimes: ['image/png', 'image/jpeg', 'image/svg+xml'], maxBytes: 2 * 1024 * 1024 },
  document: { mimes: ['application/pdf'], maxBytes: 20 * 1024 * 1024 },
};

/** Sniff the real type from magic bytes — never trust the extension or the client's Content-Type. */
export function sniffMime(buf: Buffer, filename: string): string | null {
  const head = buf.subarray(0, 8);
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (head[0] === 0x89 && head.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'video/mp4';
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05)) {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (lower.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    return 'application/zip';
  }
  const sample = buf.subarray(0, Math.min(buf.length, 2048)).toString('utf8');
  if (sample.trimStart().startsWith('<svg') || sample.includes('<svg ')) return 'image/svg+xml';
  if (!/[\x00-\x08\x0E-\x1F]/.test(sample)) return filename.toLowerCase().endsWith('.csv') ? 'text/csv' : 'text/plain';
  return null;
}

@Injectable()
export class FilesService implements OnModuleInit {
  private readonly log = new Logger('Files');
  readonly s3: S3Client;
  readonly bucket = env().S3_BUCKET;

  constructor(private readonly db: Db) {
    const e = env();
    this.s3 = new S3Client({
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: e.S3_ACCESS_KEY, secretAccessKey: e.S3_SECRET_KEY },
    });
  }

  async onModuleInit() {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      try {
        await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.log.log(`Created bucket ${this.bucket}`);
      } catch (err) {
        this.log.warn(`Object storage unavailable: ${(err as Error).message}`);
      }
    }
  }

  /** Validate and store an upload; returns the file_object row. */
  async store(tx: DbOrTx, input: { buffer: Buffer; filename: string; purpose: string; ownerUserId: string | null }) {
    const rules = ALLOWED[input.purpose];
    if (!rules) throw badRequest(`Unknown upload purpose ${input.purpose}`);
    if (input.buffer.length === 0) throw badRequest('The file is empty');
    if (input.buffer.length > rules.maxBytes) throw badRequest(`File is larger than ${Math.round(rules.maxBytes / 1024 / 1024)} MB`);
    const mime = sniffMime(input.buffer, input.filename);
    if (!mime || !rules.mimes.includes(mime)) throw badRequest('This file type is not allowed here');
    const safeName = input.filename.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
    const key = `${input.purpose}/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}-${safeName}`;
    await this.put(key, input.buffer, mime);
    const [row] = await tx
      .insert(s.fileObject)
      .values({
        bucket: this.bucket,
        key,
        filename: safeName,
        mime,
        size: input.buffer.length,
        sha256: crypto.createHash('sha256').update(input.buffer).digest('hex'),
        purpose: input.purpose,
        ownerUserId: input.ownerUserId,
      })
      .returning();
    return row!;
  }

  /** Store generated bytes (PDFs) without upload validation. */
  async storeGenerated(tx: DbOrTx, input: { buffer: Buffer; filename: string; mime: string; purpose: string; ownerUserId?: string | null }) {
    const key = `${input.purpose}/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}-${input.filename}`;
    await this.put(key, input.buffer, input.mime);
    const [row] = await tx
      .insert(s.fileObject)
      .values({ bucket: this.bucket, key, filename: input.filename, mime: input.mime, size: input.buffer.length, purpose: input.purpose, ownerUserId: input.ownerUserId ?? null })
      .returning();
    return row!;
  }

  async put(key: string, body: Buffer, mime: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: mime }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async get(fileId: string) {
    const [f] = await this.db.db.select().from(s.fileObject).where(eq(s.fileObject.id, fileId));
    if (!f) throw notFound('File');
    return f;
  }

  async read(fileId: string): Promise<Buffer> {
    const f = await this.get(fileId);
    return this.readKey(f.key);
  }

  async readKey(key: string): Promise<Buffer> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }

  /** Short-lived signed URL (default 5 minutes). Nothing is served directly from the bucket. */
  async signedUrl(fileId: string, ttlSec = 300, downloadName?: string): Promise<{ url: string; expiresAt: Date }> {
    const f = await this.get(fileId);
    return this.signedUrlForKey(f.key, ttlSec, downloadName ?? f.filename);
  }

  async signedUrlForKey(key: string, ttlSec = 300, downloadName?: string): Promise<{ url: string; expiresAt: Date }> {
    const url = await getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: downloadName ? `inline; filename="${downloadName.replace(/"/g, '')}"` : undefined,
      }),
      { expiresIn: ttlSec },
    );
    return { url, expiresAt: new Date(Date.now() + ttlSec * 1000) };
  }
}
