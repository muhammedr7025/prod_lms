import fontkit from '@pdf-lib/fontkit';
import bwipjs from 'bwip-js';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, type PDFFont, type PDFPage, rgb, degrees } from 'pdf-lib';

export type PaperFormat = 'A4' | 'A5' | '80mm';

const MM = 72 / 25.4;
const SIZES: Record<PaperFormat, [number, number]> = {
  A4: [210 * MM, 297 * MM],
  A5: [148 * MM, 210 * MM],
  '80mm': [80 * MM, 220 * MM],
};

const INK = rgb(0.106, 0.141, 0.125); // #1b2420
const MUTED = rgb(0.42, 0.45, 0.43);
const ACCENT = rgb(0.31, 0.616, 0.408); // #4f9d68
const RULE = rgb(0.82, 0.85, 0.83);
const TINT = rgb(0.933, 0.973, 0.941); // accent-100

const FONT_DIR = path.join(__dirname, '..', '..', '..', 'assets', 'fonts');
let fontCache: { regular: Buffer; bold: Buffer; heading: Buffer } | null = null;
function fonts() {
  if (!fontCache) {
    fontCache = {
      regular: fs.readFileSync(path.join(FONT_DIR, 'NotoSans-Regular.ttf')),
      bold: fs.readFileSync(path.join(FONT_DIR, 'NotoSans-SemiBold.ttf')),
      heading: fs.readFileSync(path.join(FONT_DIR, 'BarlowCondensed-SemiBold.ttf')),
    };
  }
  return fontCache;
}

export interface Party {
  name: string;
  lines: string[];
}

export interface Column {
  label: string;
  width: number; // fraction of content width
  align?: 'left' | 'right';
}

/**
 * Small layout kit over pdf-lib for institution documents (receipts,
 * invoices, statements, ID cards, report cards). Every document gets the
 * institution identity, optional barcode / QR and an optional watermark.
 */
export class DocumentKit {
  readonly doc: PDFDocument;
  page!: PDFPage;
  regular!: PDFFont;
  bold!: PDFFont;
  heading!: PDFFont;
  readonly format: PaperFormat;
  readonly margin: number;
  y = 0;
  private watermarkText: string | null = null;

  private constructor(doc: PDFDocument, format: PaperFormat) {
    this.doc = doc;
    this.format = format;
    this.margin = format === '80mm' ? 4 * MM : format === 'A5' ? 10 * MM : 16 * MM;
  }

  static async create(format: PaperFormat = 'A4', meta?: { title?: string; author?: string }): Promise<DocumentKit> {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const kit = new DocumentKit(doc, format);
    const f = fonts();
    kit.regular = await doc.embedFont(f.regular, { subset: true });
    kit.bold = await doc.embedFont(f.bold, { subset: true });
    kit.heading = await doc.embedFont(f.heading, { subset: true });
    if (meta?.title) doc.setTitle(meta.title);
    doc.setAuthor(meta?.author ?? 'Exatech');
    doc.setCreator('Exatech Institution Management Platform');
    kit.addPage();
    return kit;
  }

  get width() {
    return this.page.getWidth();
  }
  get contentWidth() {
    return this.width - this.margin * 2;
  }
  get small() {
    return this.format === '80mm';
  }
  private fs(size: number) {
    return this.small ? Math.max(6.5, size * 0.8) : this.format === 'A5' ? size * 0.9 : size;
  }

  addPage() {
    const [w, h] = SIZES[this.format];
    this.page = this.doc.addPage([w, h]);
    this.y = h - this.margin;
    if (this.watermarkText) this.drawWatermark(this.watermarkText);
  }

  ensure(space: number) {
    if (this.y - space < this.margin + 20) this.addPage();
  }

  /** Diagonal watermark on every page ("DUPLICATE", student name on notes…). */
  watermark(text: string) {
    this.watermarkText = text;
    for (const p of this.doc.getPages()) {
      const prev = this.page;
      this.page = p;
      this.drawWatermark(text);
      this.page = prev;
    }
  }

  private drawWatermark(text: string) {
    const size = this.small ? 18 : 48;
    const w = this.bold.widthOfTextAtSize(text, size);
    this.page.drawText(text, {
      x: this.width / 2 - (w / 2) * Math.cos(Math.PI / 6),
      y: this.page.getHeight() / 2 - (w / 2) * Math.sin(Math.PI / 6),
      size,
      font: this.bold,
      color: rgb(0.85, 0.2, 0.2),
      opacity: 0.18,
      rotate: degrees(30),
    });
  }

  text(t: string, opts: { x?: number; size?: number; bold?: boolean; heading?: boolean; color?: ReturnType<typeof rgb>; align?: 'left' | 'right' | 'center'; width?: number; advance?: boolean } = {}) {
    const size = this.fs(opts.size ?? 10);
    const font = opts.heading ? this.heading : opts.bold ? this.bold : this.regular;
    const maxW = opts.width ?? this.contentWidth;
    const lines = this.wrap(t, font, size, maxW);
    for (const line of lines) {
      this.ensure(size + 2);
      const w = font.widthOfTextAtSize(line, size);
      const x0 = opts.x ?? this.margin;
      const x = opts.align === 'right' ? x0 + maxW - w : opts.align === 'center' ? x0 + (maxW - w) / 2 : x0;
      this.page.drawText(line, { x, y: this.y - size, size, font, color: opts.color ?? INK });
      if (opts.advance !== false) this.y -= size * 1.35;
    }
    return this;
  }

  private wrap(t: string, font: PDFFont, size: number, maxW: number): string[] {
    const out: string[] = [];
    for (const para of t.split('\n')) {
      const words = para.split(/\s+/);
      let line = '';
      for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) > maxW && line) {
          out.push(line);
          line = word;
        } else line = next;
      }
      out.push(line);
    }
    return out;
  }

  gap(h = 8) {
    this.y -= this.small ? h * 0.6 : h;
    return this;
  }

  rule(color = RULE, thickness = 0.6) {
    this.page.drawLine({ start: { x: this.margin, y: this.y }, end: { x: this.width - this.margin, y: this.y }, thickness, color });
    this.y -= 6;
    return this;
  }

  /** Brand header: mark + institution, document title and number on the right. */
  header(input: { institution: string; branch?: Party; title: string; number?: string; date?: string; gstin?: string | null }) {
    const top = this.y;
    const mark = this.small ? 14 : 22;
    this.page.drawRectangle({ x: this.margin, y: top - mark, width: mark, height: mark, color: ACCENT });
    this.page.drawText('E', { x: this.margin + mark * 0.3, y: top - mark * 0.78, size: mark * 0.7, font: this.heading, color: rgb(1, 1, 1) });
    this.page.drawText(input.institution.toUpperCase(), { x: this.margin + mark + 6, y: top - mark * 0.72, size: this.fs(16), font: this.heading, color: INK });
    const right = this.width - this.margin;
    const title = input.title.toUpperCase();
    const tw = this.heading.widthOfTextAtSize(title, this.fs(15));
    if (!this.small) this.page.drawText(title, { x: right - tw, y: top - this.fs(15), size: this.fs(15), font: this.heading, color: ACCENT });
    this.y = top - mark - 6;
    if (this.small) this.text(title, { heading: true, size: 13, color: ACCENT });
    if (input.branch) {
      this.text(input.branch.name, { bold: true, size: 9 });
      for (const l of input.branch.lines) this.text(l, { size: 8, color: MUTED });
    }
    if (input.gstin) this.text(`GSTIN ${input.gstin}`, { size: 8, color: MUTED });
    if (input.number || input.date) {
      const yy = this.small ? this.y : top - mark - 6;
      if (!this.small) {
        const lines = [input.number ? `No. ${input.number}` : '', input.date ? `Date ${input.date}` : ''].filter(Boolean);
        lines.forEach((l, i) => {
          const w = this.regular.widthOfTextAtSize(l, this.fs(9));
          this.page.drawText(l, { x: right - w, y: yy - this.fs(9) * (i + 1) * 1.4, size: this.fs(9), font: this.regular, color: INK });
        });
      } else {
        if (input.number) this.text(`No. ${input.number}`, { size: 8 });
        if (input.date) this.text(`Date ${input.date}`, { size: 8 });
      }
    }
    this.gap(6).rule(INK, 1);
    return this;
  }

  /** Two-column key → value list. */
  keyValues(pairs: [string, string][], labelWidth = 0.32) {
    const lw = this.contentWidth * labelWidth;
    for (const [k, v] of pairs) {
      const size = this.fs(9);
      this.ensure(size + 4);
      const yBefore = this.y;
      this.page.drawText(k, { x: this.margin, y: this.y - size, size, font: this.regular, color: MUTED });
      this.text(v, { x: this.margin + lw, size: 9, width: this.contentWidth - lw });
      if (this.y > yBefore - size * 1.35) this.y = yBefore - size * 1.35;
    }
    return this.gap(4);
  }

  table(columns: Column[], rows: string[][], opts: { header?: boolean; boldLast?: boolean } = {}) {
    const size = this.fs(9);
    const xs: number[] = [];
    let x = this.margin;
    for (const c of columns) {
      xs.push(x);
      x += c.width * this.contentWidth;
    }
    const drawRow = (cells: string[], bold: boolean, fill?: ReturnType<typeof rgb>) => {
      this.ensure(size * 2);
      const h = size * 1.9;
      if (fill) this.page.drawRectangle({ x: this.margin, y: this.y - h + 3, width: this.contentWidth, height: h, color: fill });
      cells.forEach((cell, i) => {
        const col = columns[i]!;
        const font = bold ? this.bold : this.regular;
        const cw = col.width * this.contentWidth - 6;
        let t = cell;
        while (font.widthOfTextAtSize(t, size) > cw && t.length > 1) t = t.slice(0, -2) + '…';
        const w = font.widthOfTextAtSize(t, size);
        const cx = col.align === 'right' ? xs[i]! + col.width * this.contentWidth - w - 3 : xs[i]! + 3;
        this.page.drawText(t, { x: cx, y: this.y - size * 1.25, size, font, color: INK });
      });
      this.y -= h;
      this.page.drawLine({ start: { x: this.margin, y: this.y + 3 }, end: { x: this.width - this.margin, y: this.y + 3 }, thickness: 0.4, color: RULE });
    };
    if (opts.header !== false) drawRow(columns.map((c) => c.label.toUpperCase()), true, TINT);
    rows.forEach((r, i) => drawRow(r, !!opts.boldLast && i === rows.length - 1));
    return this.gap(6);
  }

  /** Code 128 barcode (admission number) — printed on ID cards, invoices and receipts. */
  async barcode(text: string, opts: { width?: number; height?: number; x?: number } = {}) {
    const png = await bwipjs.toBuffer({ bcid: 'code128', text, scale: 3, height: 10, includetext: true, textxalign: 'center', textsize: 9 });
    const img = await this.doc.embedPng(png);
    const w = opts.width ?? (this.small ? this.contentWidth : 150);
    const h = opts.height ?? (w * img.height) / img.width;
    this.ensure(h + 4);
    this.page.drawImage(img, { x: opts.x ?? this.margin, y: this.y - h, width: w, height: h });
    this.y -= h + 6;
    return this;
  }

  /** QR code (verification link or signed card token). */
  async qr(text: string, opts: { size?: number; x?: number; y?: number; advance?: boolean } = {}) {
    const png = await bwipjs.toBuffer({ bcid: 'qrcode', text, scale: 4, paddingwidth: 1, paddingheight: 1 });
    const img = await this.doc.embedPng(png);
    const size = opts.size ?? (this.small ? 70 : 78);
    const x = opts.x ?? this.width - this.margin - size;
    const y = opts.y ?? this.y - size;
    this.page.drawImage(img, { x, y, width: size, height: size });
    if (opts.advance) this.y -= size + 4;
    return this;
  }

  footer(text: string) {
    for (const p of this.doc.getPages()) {
      const size = this.fs(7.5);
      p.drawText(text, { x: this.margin, y: this.margin / 2, size, font: this.regular, color: MUTED, maxWidth: this.contentWidth });
    }
    return this;
  }

  async save(): Promise<Buffer> {
    return Buffer.from(await this.doc.save());
  }
}

export { INK, MUTED, ACCENT, RULE, TINT, MM };
