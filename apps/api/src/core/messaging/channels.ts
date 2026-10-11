import { Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env';

export interface OutgoingMessage {
  channel: 'whatsapp' | 'email' | 'sms';
  to: string;
  subject?: string | null;
  body: string;
  html?: string | null;
  template?: string | null;
  attachments?: { filename: string; content?: Buffer; url?: string }[];
}

export interface DeliveryResult {
  provider: string;
  providerMessageId: string | null;
}

/** Port: every provider implements this (open for extension, closed for modification). */
export interface NotificationChannel {
  readonly name: string;
  supports(channel: OutgoingMessage['channel']): boolean;
  send(msg: OutgoingMessage): Promise<DeliveryResult>;
}

export class SmtpEmailChannel implements NotificationChannel {
  readonly name = 'smtp';
  private transporter: Transporter;
  constructor() {
    const e = env();
    this.transporter = nodemailer.createTransport({
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      secure: e.SMTP_PORT === 465,
      auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASS } : undefined,
    });
  }
  supports(c: OutgoingMessage['channel']) {
    return c === 'email';
  }
  async send(msg: OutgoingMessage): Promise<DeliveryResult> {
    const info = await this.transporter.sendMail({
      from: env().MAIL_FROM,
      to: msg.to,
      subject: msg.subject ?? 'Exatech',
      text: msg.body,
      html: msg.html ?? undefined,
      attachments: msg.attachments?.filter((a) => a.content).map((a) => ({ filename: a.filename, content: a.content! })),
    });
    return { provider: this.name, providerMessageId: info.messageId ?? null };
  }
}

export class ResendEmailChannel implements NotificationChannel {
  readonly name = 'resend';
  supports(c: OutgoingMessage['channel']) {
    return c === 'email';
  }
  async send(msg: OutgoingMessage): Promise<DeliveryResult> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env().RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env().MAIL_FROM,
        to: [msg.to],
        subject: msg.subject ?? 'Exatech',
        text: msg.body,
        html: msg.html ?? undefined,
        attachments: msg.attachments?.filter((a) => a.content).map((a) => ({ filename: a.filename, content: a.content!.toString('base64') })),
      }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { id?: string };
    return { provider: this.name, providerMessageId: json.id ?? null };
  }
}

/** WhatsApp Business Cloud API. Templates must be Meta-approved for messages outside the 24 h window. */
export class MetaWhatsAppChannel implements NotificationChannel {
  readonly name = 'whatsapp-cloud';
  supports(c: OutgoingMessage['channel']) {
    return c === 'whatsapp' || c === 'sms';
  }
  async send(msg: OutgoingMessage): Promise<DeliveryResult> {
    const e = env();
    const to = msg.to.replace(/^\+/, '');
    const link = msg.attachments?.find((a) => a.url);
    const payload = link
      ? { messaging_product: 'whatsapp', to, type: 'document', document: { link: link.url, filename: link.filename, caption: msg.body.slice(0, 1000) } }
      : { messaging_product: 'whatsapp', to, type: 'text', text: { body: msg.body.slice(0, 4096) } };
    const res = await fetch(`https://graph.facebook.com/v21.0/${e.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${e.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { messages?: { id: string }[] };
    return { provider: this.name, providerMessageId: json.messages?.[0]?.id ?? null };
  }
}

/** Development stand-in: messages are recorded in the outbox (visible at /dev/outbox) and logged. */
export class DevWhatsAppChannel implements NotificationChannel {
  readonly name = 'dev-whatsapp';
  private readonly log = new Logger('WhatsApp(dev)');
  supports(c: OutgoingMessage['channel']) {
    return c === 'whatsapp' || c === 'sms';
  }
  async send(msg: OutgoingMessage): Promise<DeliveryResult> {
    this.log.log(`→ ${msg.to}: ${msg.body.replace(/\s+/g, ' ').slice(0, 160)}`);
    return { provider: this.name, providerMessageId: null };
  }
}

export function buildChannels(): NotificationChannel[] {
  const e = env();
  return [
    e.RESEND_API_KEY ? new ResendEmailChannel() : new SmtpEmailChannel(),
    e.WHATSAPP_TOKEN && e.WHATSAPP_PHONE_NUMBER_ID ? new MetaWhatsAppChannel() : new DevWhatsAppChannel(),
  ];
}
