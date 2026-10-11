import { Injectable, Logger } from '@nestjs/common';
import { DomainError, forbidden, invalid } from '../../core/errors';

const MODEL = 'claude-sonnet-5-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

const SYSTEM = `You draft announcements for Exatech, a professional training institute in Kerala, India (courses in digital marketing, full stack development, data analytics and UI/UX). Readers are students and their parents, sometimes staff.
Write a short, clear, friendly announcement from the notes you are given: a title of at most 80 characters and a message of 30–90 words in plain text (no markdown, no emoji, no greeting line, no signature).
Use only facts present in the notes — never invent dates, times, rooms, amounts or names. Keep dates, times and amounts exactly as written. If the notes are too thin to write a useful message, write the best short message you can from the title alone.`;

interface MessagesResponse {
  stop_reason?: string;
  content?: { type: string; text?: string }[];
  error?: { message?: string };
}

/**
 * Opt-in AI assist for the announcement composer (PRD §6 "AI assist"). Drafts a
 * title and message from the author's notes; it never publishes or sends.
 * Enabled only when ANTHROPIC_API_KEY is set. Raw HTTPS call: the API package
 * does not depend on @anthropic-ai/sdk.
 */
@Injectable()
export class AiDraftService {
  private readonly log = new Logger('AiDraft');

  get enabled(): boolean {
    return !!process.env.ANTHROPIC_API_KEY;
  }

  async draft(input: { title: string; notes: string; audience?: string }): Promise<{ title: string; body: string }> {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw forbidden('AI drafting is not configured on this server');
    if (!input.title && !input.notes) throw invalid('Write a title or a few notes for the assistant to work from');
    const userText = [`Title idea: ${input.title || '(none)'}`, `Audience: ${input.audience || 'students and parents'}`, `Notes:\n${input.notes || '(none)'}`].join('\n');
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'server-side-fallback-2026-07-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4000,
          system: SYSTEM,
          fallbacks: 'default',
          output_config: {
            effort: 'low',
            format: {
              type: 'json_schema',
              schema: {
                type: 'object',
                properties: { title: { type: 'string' }, body: { type: 'string' } },
                required: ['title', 'body'],
                additionalProperties: false,
              },
            },
          },
          messages: [{ role: 'user', content: userText }],
        }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (err) {
      this.log.warn(`draft request failed: ${(err as Error).message}`);
      throw new DomainError('AI_UNAVAILABLE', 'The AI assistant did not respond — try again or write it yourself', 503);
    }
    const data = (await res.json().catch(() => ({}))) as MessagesResponse;
    if (!res.ok) {
      this.log.warn(`draft API ${res.status}: ${data.error?.message ?? 'unknown error'}`);
      throw new DomainError('AI_UNAVAILABLE', res.status === 429 ? 'The AI assistant is busy — try again in a minute' : 'The AI assistant could not draft this — write it yourself', 503);
    }
    if (data.stop_reason === 'refusal') throw invalid('The AI assistant declined to draft this — write it yourself');
    const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    try {
      const parsed = JSON.parse(text) as { title?: unknown; body?: unknown };
      const title = String(parsed.title ?? '').trim().slice(0, 140);
      const body = String(parsed.body ?? '').trim().slice(0, 4000);
      if (!title || !body) throw new Error('empty draft');
      return { title, body };
    } catch {
      throw new DomainError('AI_UNAVAILABLE', 'The AI assistant returned an unusable draft — try again', 503);
    }
  }
}
