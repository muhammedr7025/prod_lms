import { Injectable } from '@nestjs/common';
import { formatDate, todayIST } from '@exatech/domain';
import bwipjs from 'bwip-js';
import { rgb } from 'pdf-lib';
import { ACCENT, DocumentKit, INK, MM, MUTED, RULE } from '../../core/documents/document-kit';
import { CardTokens } from './card-tokens';

export interface CardInput {
  name: string;
  admissionNo: string | null;
  cardToken: string;
  batchCode: string | null;
  courseName: string | null;
  branchName: string;
  validUntil: string | null;
}

const CARD_W = 85.6 * MM;
const CARD_H = 54 * MM;

/**
 * Student ID cards (CR80 size) on A4: name, admission number, batch, course,
 * validity, Code 128 of the admission number and a QR of the signed card token.
 */
@Injectable()
export class IdCardsService {
  constructor(private readonly tokens: CardTokens) {}

  async render(institution: string, cards: CardInput[], title: string): Promise<Buffer> {
    const kit = await DocumentKit.create('A4', { title });
    kit.header({ institution, title: 'Student ID cards', number: title, date: formatDate(todayIST()) });
    kit.text(cards.length === 1 ? 'Cut along the outline. The QR resolves at the front desk until the card is reissued.' : `${cards.length} cards · cut along the outlines. QR codes resolve at the front desk until a card is reissued.`, { size: 8.5, color: MUTED });
    kit.gap(6);
    const gapX = 10 * MM;
    const gapY = 8 * MM;
    const left = kit.margin + (kit.contentWidth - (CARD_W * 2 + gapX)) / 2;
    let top = kit.y;
    let col = 0;
    for (const card of cards) {
      if (top - CARD_H < kit.margin + 10) {
        kit.addPage();
        top = kit.y;
        col = 0;
      }
      const x = left + col * (CARD_W + gapX);
      await this.drawCard(kit, institution, card, x, top);
      col++;
      if (col === 2) {
        col = 0;
        top -= CARD_H + gapY;
      }
    }
    kit.footer(`${institution} · student ID cards · generated ${formatDate(todayIST())} · lost cards must be reissued (old QR stops working)`);
    return kit.save();
  }

  private async drawCard(kit: DocumentKit, institution: string, c: CardInput, x: number, top: number) {
    const page = kit.page;
    const y0 = top - CARD_H;
    page.drawRectangle({ x, y: y0, width: CARD_W, height: CARD_H, borderColor: RULE, borderWidth: 0.8, color: rgb(1, 1, 1) });
    // Brand band
    const band = 16;
    page.drawRectangle({ x, y: top - band, width: CARD_W, height: band, color: ACCENT });
    page.drawText(institution.toUpperCase(), { x: x + 7, y: top - band + 4.5, size: 10, font: kit.heading, color: rgb(1, 1, 1) });
    const tag = 'STUDENT ID';
    page.drawText(tag, { x: x + CARD_W - 7 - kit.bold.widthOfTextAtSize(tag, 6.5), y: top - band + 5.5, size: 6.5, font: kit.bold, color: rgb(1, 1, 1) });
    // Photo placeholder with initials
    const px = x + 7;
    const ph = 46;
    const pw = 38;
    const py = top - band - 6 - ph;
    page.drawRectangle({ x: px, y: py, width: pw, height: ph, color: rgb(0.933, 0.973, 0.941), borderColor: RULE, borderWidth: 0.5 });
    const initials = c.name
      .split(/\s+/)
      .map((w) => w[0] ?? '')
      .join('')
      .slice(0, 2)
      .toUpperCase();
    page.drawText(initials, { x: px + pw / 2 - kit.heading.widthOfTextAtSize(initials, 16) / 2, y: py + ph / 2 - 6, size: 16, font: kit.heading, color: ACCENT });
    // Text block
    const tx = px + pw + 7;
    const maxW = CARD_W - (tx - x) - 7;
    const fit = (t: string, size: number, font = kit.regular) => {
      let s = t;
      while (font.widthOfTextAtSize(s, size) > maxW && s.length > 2) s = s.slice(0, -2) + '…';
      return s;
    };
    let ty = top - band - 13;
    page.drawText(fit(c.name, 10.5, kit.bold), { x: tx, y: ty, size: 10.5, font: kit.bold, color: INK });
    ty -= 11;
    page.drawText(fit(c.admissionNo ?? 'No admission number', 7.5), { x: tx, y: ty, size: 7.5, font: kit.regular, color: INK });
    ty -= 9.5;
    page.drawText(fit([c.batchCode, c.courseName].filter(Boolean).join(' · ') || 'Not enrolled', 7), { x: tx, y: ty, size: 7, font: kit.regular, color: MUTED });
    ty -= 9;
    page.drawText(fit(c.branchName, 7), { x: tx, y: ty, size: 7, font: kit.regular, color: MUTED });
    ty -= 9;
    page.drawText(fit(c.validUntil ? `Valid till ${formatDate(c.validUntil)}` : 'Valid while enrolled', 7), { x: tx, y: ty, size: 7, font: kit.bold, color: INK });
    // Code 128 (admission number) bottom-left, QR (signed token) bottom-right
    const qrSize = 46;
    const qrPng = await bwipjs.toBuffer({ bcid: 'qrcode', text: this.tokens.payload(c.cardToken), scale: 4, paddingwidth: 1, paddingheight: 1 });
    const qr = await kit.doc.embedPng(qrPng);
    page.drawImage(qr, { x: x + CARD_W - qrSize - 6, y: y0 + 5, width: qrSize, height: qrSize });
    if (c.admissionNo) {
      const bc = await bwipjs.toBuffer({ bcid: 'code128', text: c.admissionNo, scale: 2, height: 7, includetext: true, textxalign: 'center', textsize: 7 });
      const img = await kit.doc.embedPng(bc);
      const bw = Math.min(CARD_W - qrSize - 22, 150);
      const bh = Math.min(30, (bw * img.height) / img.width);
      page.drawImage(img, { x: x + 7, y: y0 + 6, width: bw, height: bh });
    }
  }
}
