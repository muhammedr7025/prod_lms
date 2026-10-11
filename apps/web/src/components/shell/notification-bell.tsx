'use client';

import { notificationsContract } from '@exatech/contracts';
import { formatRelative } from '@exatech/domain';
import { Button, CardTitle, Icon, Popover, Tag } from '@exatech/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useApi, useApiMutation } from '@/lib/hooks';

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { data } = useApi(notificationsContract.list, { query: { limit: 20 } }, { staleTime: 15_000 });
  const markAll = useApiMutation(notificationsContract.markAllRead, { invalidate: [['notifications']] });
  const unread = data?.unread ?? 0;

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o && unread > 0) markAll.mutate({});
      }}
      width={360}
      trigger={
        <Button variant="secondary" size="iconSm" className="relative" aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}>
          <Icon name="bell" size={17} />
          {unread > 0 && <span className="absolute -top-1.5 -right-1.5 min-w-4 h-4 px-1 bg-accent text-white text-[10px] font-bold grid place-items-center">{unread > 99 ? '99+' : unread}</span>}
        </Button>
      }
    >
      <div className="flex justify-between items-center px-3.5 py-3 border-b border-divider">
        <CardTitle>Notifications</CardTitle>
        <Tag variant="neutral">Live · SSE</Tag>
      </div>
      <div className="max-h-[60vh] overflow-auto">
        {(data?.items ?? []).length === 0 && <div className="px-3.5 py-6 text-[13px] text-neutral-600">You are all caught up.</div>}
        {data?.items.map((n) => (
          <button
            key={n.id}
            type="button"
            onClick={() => {
              setOpen(false);
              if (n.link) router.push(n.link);
            }}
            className="w-full text-left px-3.5 py-2.5 border-0 border-b border-divider bg-transparent text-[13px] grid gap-0.5 cursor-pointer hover:bg-accent-100"
          >
            <div className="flex justify-between gap-2">
              <b className={n.readAt ? 'font-normal' : 'font-medium'}>{n.title}</b>
              <span className="text-[11px] text-neutral-500 whitespace-nowrap">{formatRelative(new Date(n.createdAt))}</span>
            </div>
            <div className="text-neutral-700">{n.body}</div>
          </button>
        ))}
      </div>
      <div className="px-3.5 py-2.5 text-xs text-neutral-600">Channel preferences per category · fee due and exam schedule cannot be muted.</div>
    </Popover>
  );
}
