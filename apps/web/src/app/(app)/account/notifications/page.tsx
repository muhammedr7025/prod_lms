'use client';

import { notificationsContract } from '@exatech/contracts';
import { Card, Checkbox, Kicker, Page, PageHeader, Row, Tag } from '@exatech/ui';
import { useApi, useApiMutation } from '@/lib/hooks';

const CHANNELS = [
  { key: 'in_app', label: 'In-app' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'email', label: 'Email' },
] as const;

/** Channel preferences per category. Fee due and exam schedule cannot be muted. */
export default function NotificationPreferencesPage() {
  const { data } = useApi(notificationsContract.preferences, {});
  const save = useApiMutation(notificationsContract.setPreference, { invalidate: [['notifications', 'preferences']], success: 'Preferences saved' });
  return (
    <Page label="Notification preferences" className="max-w-[760px]">
      <PageHeader kicker="Account" title="Notification preferences" />
      <Card>
        <Kicker>Channels per category</Kicker>
        {data?.map((p, i) => (
          <Row key={p.category} last={i === data.length - 1} className="items-center flex-wrap">
            <span className="flex items-center gap-2">
              {p.label}
              {!p.mutable && <Tag variant="accent">cannot mute</Tag>}
            </span>
            <span className="flex gap-4">
              {CHANNELS.map((c) => (
                <Checkbox
                  key={c.key}
                  label={c.label}
                  checked={p.channels.includes(c.key)}
                  disabled={!p.mutable || save.isPending}
                  onChange={(on) => {
                    const channels = on ? [...new Set([...p.channels, c.key])] : p.channels.filter((x) => x !== c.key);
                    save.mutate({ body: { category: p.category, channels: channels as ('whatsapp' | 'email' | 'in_app')[] } });
                  }}
                />
              ))}
            </span>
          </Row>
        ))}
      </Card>
    </Page>
  );
}
