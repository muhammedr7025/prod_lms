'use client';

import { devContract } from '@exatech/contracts';
import { formatRelative } from '@exatech/domain';
import { Card, CardTitle, EmptyState, Kicker, Page, PageHeader, Tag } from '@exatech/ui';
import { useApi } from '@/lib/hooks';

/**
 * DEMO_MODE only: every WhatsApp / email / SMS the platform sent, so flows that
 * message parents (receipts, absence alerts, OTPs) can be verified without a
 * live WhatsApp account. Email also lands in Mailpit (http://localhost:8025).
 */
export default function OutboxPage() {
  const { data, error } = useApi(devContract.outbox, {}, { refetchInterval: 4000 });
  return (
    <div className="min-h-screen bg-surface">
      <Page label="Dev outbox" className="max-w-[900px] mx-auto">
        <PageHeader kicker="Demo mode · refreshes every 4 s" title="Message outbox" />
        {error && <EmptyState title="Outbox unavailable" body="Demo mode is off, or the API is not running." />}
        {data?.length === 0 && <EmptyState title="No messages yet" />}
        <div className="grid gap-2.5">
          {data?.map((m) => (
            <Card key={m.id} pad="md">
              <div className="flex justify-between gap-2 flex-wrap">
                <Kicker>
                  {m.channel} → {m.toAddress}
                </Kicker>
                <span className="flex gap-2 items-center">
                  <Tag variant={m.status === 'sent' ? 'accent' : m.status === 'failed' ? 'ink' : 'neutral'}>{m.status}</Tag>
                  <span className="text-[11px] text-neutral-500">{formatRelative(new Date(m.createdAt))}</span>
                </span>
              </div>
              {m.subject && <CardTitle>{m.subject}</CardTitle>}
              <div className="text-[13px] whitespace-pre-wrap break-words">{m.body}</div>
              {m.attachments.length > 0 && <div className="flex gap-1.5 flex-wrap">{m.attachments.map((a) => <Tag key={a.filename} variant="outline">{a.filename}</Tag>)}</div>}
            </Card>
          ))}
        </div>
      </Page>
    </div>
  );
}
