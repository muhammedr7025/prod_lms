'use client';

import type { RealtimeMessage } from '@exatech/contracts';
import { toast } from '@exatech/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { invalidatePrefixes } from '@/lib/hooks';

/**
 * One SSE connection per tab. Notifications ring the bell (and toast);
 * invalidations refetch the affected queries (payments, publishes, attendance).
 */
export function RealtimeBridge({ branchKey }: { branchKey: string }) {
  const qc = useQueryClient();
  useEffect(() => {
    let es: EventSource | null = null;
    let failures = 0;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      es = new EventSource('/api/realtime/stream');
      es.onopen = () => {
        failures = 0;
      };
      es.onmessage = (ev) => {
        let msg: RealtimeMessage;
        try {
          msg = JSON.parse(ev.data) as RealtimeMessage;
        } catch {
          return;
        }
        if (msg.keys?.length) void invalidatePrefixes(qc, msg.keys);
        if (msg.kind === 'notification' && msg.notification) {
          void invalidatePrefixes(qc, [['notifications']]);
          toast(msg.notification.title);
        }
      };
      es.onerror = () => {
        es?.close();
        if (closed) return;
        failures++;
        // Back off; a dead session is caught by the next API call's 401 handler.
        timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
        if (failures >= 3) void qc.invalidateQueries({ queryKey: ['api', 'me'] });
      };
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      es?.close();
    };
  }, [qc, branchKey]);
  return null;
}
