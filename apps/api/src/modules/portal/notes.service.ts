import { Injectable } from '@nestjs/common';
import type { NoteItem, PortalNotes } from '@exatech/contracts';
import * as s from '@exatech/db';
import { and, asc, eq, isNull } from '@exatech/db';
import { canAccessMaterial, formatDate, formatDayMonth, formatINR, todayIST, toISTDate } from '@exatech/domain';
import fontkit from '@pdf-lib/fontkit';
import fs from 'node:fs';
import path from 'node:path';
import { degrees, PDFDocument, rgb, StandardFonts, type PDFFont } from 'pdf-lib';
import { ctx } from '../../core/context';
import { DomainError, invalid, notFound } from '../../core/errors';
import { FilesService } from '../../core/files/files.service';
import { PortalShared } from './portal.shared';

const NOTO = path.join(__dirname, '..', '..', '..', 'assets', 'fonts', 'NotoSans-SemiBold.ttf');
const SIGNED_URL_TTL = 300;

/**
 * Stamp "<name> · <admission no> · <date>" diagonally and a licence footer on
 * every page. Uses Helvetica when the text is WinAnsi-encodable (so the stamp
 * stays searchable text), else the embedded Noto Sans.
 */
export async function watermarkPdf(src: Buffer, stamp: string, footer: string): Promise<Buffer> {
  const doc = await PDFDocument.load(src, { ignoreEncryption: true });
  doc.registerFontkit(fontkit);
  let font: PDFFont = await doc.embedFont(StandardFonts.HelveticaBold);
  try {
    font.encodeText(stamp);
    font.encodeText(footer);
  } catch {
    font = await doc.embedFont(fs.readFileSync(NOTO), { subset: true });
  }
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const angle = Math.atan2(height, width);
    const unit = font.widthOfTextAtSize(stamp, 1);
    const size = Math.max(12, Math.min(40, (Math.hypot(width, height) * 0.7) / Math.max(unit, 1)));
    const tw = unit * size;
    page.drawText(stamp, {
      x: width / 2 - (tw / 2) * Math.cos(angle) + (size / 3) * Math.sin(angle),
      y: height / 2 - (tw / 2) * Math.sin(angle) - (size / 3) * Math.cos(angle),
      size,
      font,
      color: rgb(0.85, 0.2, 0.2),
      opacity: 0.16,
      rotate: degrees((angle * 180) / Math.PI),
    });
    page.drawText(footer, { x: 24, y: 12, size: 7, font, color: rgb(0.42, 0.45, 0.43), maxWidth: width - 48 });
  }
  doc.setSubject(footer);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** Student · Notes: fee-gated material with server-side access checks and watermarked, short-lived links. */
@Injectable()
export class NotesService {
  constructor(
    private readonly shared: PortalShared,
    private readonly files: FilesService,
  ) {}

  async list(studentId?: string): Promise<PortalNotes> {
    const sc = await this.shared.resolve(studentId);
    const [rows, fee] = await Promise.all([
      this.shared.db.db
        .select()
        .from(s.material)
        .where(and(eq(s.material.batchId, sc.batchId), isNull(s.material.removedAt)))
        .orderBy(asc(s.material.module), asc(s.material.createdAt)),
      this.shared.feeSummary(sc),
    ]);
    const now = new Date();
    const items = rows.map((m): NoteItem & { module: string } => {
      const open = canAccessMaterial({ visibility: m.visibility, releaseAt: m.releaseAt }, { feeCleared: fee.feeCleared }, now);
      const scheduled = !open && !!m.releaseAt && m.releaseAt.getTime() > now.getTime();
      const meta = [m.type, m.meta && m.meta !== 'scheduled' ? m.meta : null].filter(Boolean).join(' · ');
      return {
        id: m.id,
        module: m.module,
        title: m.title,
        type: m.type,
        meta,
        status: open ? 'open' : scheduled ? 'scheduled' : 'locked',
        label: open ? 'Open' : scheduled ? `Scheduled · ${formatDayMonth(toISTDate(m.releaseAt!))}` : 'Locked · Pay now',
        tagVariant: open ? 'accent' : scheduled ? 'neutral' : 'ink',
      };
    });
    const groups: PortalNotes['groups'] = [];
    for (const it of items) {
      const { module, ...item } = it;
      let g = groups.find((x) => x.module === module);
      if (!g) groups.push((g = { module, items: [] }));
      g.items.push(item);
    }
    groups.sort((a, b) => a.module.localeCompare(b.module, 'en', { numeric: true }));
    const available = items.filter((i) => i.status === 'open').length;
    const anyLocked = items.some((i) => i.status === 'locked');
    return {
      kicker: `${sc.batchCode} · ${available} of ${items.length} available`,
      available,
      total: items.length,
      lockedBanner: anyLocked && fee.pay ? { text: `Fee-gated items unlock when ${fee.pay.instalmentLabel.toLowerCase()} is paid.`, payLabel: `Pay ${formatINR(fee.pay.nextDue)}` } : null,
      pay: fee.pay,
      groups,
    };
  }

  /**
   * Re-check canAccessMaterial on the server (fresh enrollment.feeCleared +
   * releaseAt), log the access, and return a 5-minute signed URL — for PDFs, of
   * a copy watermarked with the student's name (cached per student per file).
   */
  async open(materialId: string): Promise<{ kind: 'file' | 'link'; url: string; expiresAt: Date | null; watermarked: boolean }> {
    const sc = await this.shared.ownEnrollment();
    const db = this.shared.db.db;
    const [m] = await db.select().from(s.material).where(and(eq(s.material.id, materialId), isNull(s.material.removedAt)));
    if (!m || m.batchId !== sc.batchId) throw notFound('Note');
    const [enr] = await db.select({ feeCleared: s.enrollment.feeCleared }).from(s.enrollment).where(eq(s.enrollment.id, sc.enrollmentId));
    const now = new Date();
    if (!canAccessMaterial({ visibility: m.visibility, releaseAt: m.releaseAt }, { feeCleared: enr?.feeCleared ?? false }, now)) {
      if (m.releaseAt && m.releaseAt.getTime() > now.getTime()) throw invalid(`“${m.title}” is available from ${formatDayMonth(toISTDate(m.releaseAt))}`);
      const fee = await this.shared.feeSummary(sc);
      throw new DomainError('FEE_LOCKED', fee.pay ? `Locked — pay ${fee.pay.instalmentLabel.toLowerCase()} (${formatINR(fee.pay.nextDue)}) to open “${m.title}”` : `Locked until your fee payment clears`, 403);
    }
    await db.insert(s.materialAccess).values({ materialId: m.id, userId: ctx().userId, enrollmentId: sc.enrollmentId });

    if (!m.fileId) {
      if (!m.url) throw notFound('File for this note');
      return { kind: 'link', url: m.url, expiresAt: null, watermarked: false };
    }
    const file = await this.files.get(m.fileId);
    const safeTitle = m.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'note';
    if (file.mime !== 'application/pdf') {
      const { url, expiresAt } = await this.files.signedUrl(file.id, SIGNED_URL_TTL);
      return { kind: 'file', url, expiresAt, watermarked: false };
    }
    const key = `watermarked/${file.id}/${sc.studentId}.pdf`;
    if (!(await this.files.exists(key))) {
      const issued = formatDate(todayIST());
      const who = [sc.name, sc.admissionNo].filter(Boolean).join(' · ');
      const out = await watermarkPdf(await this.files.read(file.id), `${who} · ${issued}`, `Licensed to ${who} · issued ${issued} · for personal study only — do not share`);
      await this.files.put(key, out, 'application/pdf');
    }
    const { url, expiresAt } = await this.files.signedUrlForKey(key, SIGNED_URL_TTL, `${safeTitle}.pdf`);
    return { kind: 'file', url, expiresAt, watermarked: true };
  }
}
