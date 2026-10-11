'use client';

import { teachingAttendanceContract } from '@exatech/contracts';
import { Button, Dialog, Skeleton } from '@exatech/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { invalidatePrefixes, useApi } from '@/lib/hooks';

function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** QR self check-in: rotating 5-minute code (text + QR), countdown and a live "present so far" count. */
export function QrDialog({ sessionId, open, onOpenChange }: { sessionId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const { data, error, refetch } = useApi(teachingAttendanceContract.qr, { params: { id: sessionId } }, { enabled: open, refetchInterval: open ? 5000 : false, staleTime: 0 });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);
  const left = data ? Date.parse(data.expiresAt) - now : 0;
  useEffect(() => {
    if (open && data && left <= 0) void refetch();
  }, [open, data, left, refetch]);
  // Keep the roster behind the dialog in step with check-ins.
  const present = data?.presentSoFar;
  useEffect(() => {
    if (open && present != null) void invalidatePrefixes(qc, [['teaching', 'attendance']]);
  }, [open, present, qc]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      center
      width={380}
      kicker={`Self check-in · expires in ${data ? mmss(left) : '5:00'}`}
      title="Show this to the class"
      footerAlign="center"
      footer={
        <Button variant="primary" size="lg" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      }
    >
      {error ? (
        <div className="text-[13px]">{error.message}</div>
      ) : data ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.svg)}`} alt={`QR code ${data.code}`} width={200} height={200} className="w-[200px] h-[200px] border-8 border-white outline outline-1 outline-divider" />
          <div className="font-mono text-sm tracking-[0.08em]" data-testid="qr-code">
            {data.code}
          </div>
          <div className="text-[13px] text-neutral-700">
            Students scan from their portal and are marked Present automatically — <b className="font-semibold">{data.presentSoFar}</b> present so far. Rotates every 5 minutes; only works on the branch Wi-Fi or within 100 m.
          </div>
        </>
      ) : (
        <>
          <Skeleton className="w-[200px] h-[200px]" />
          <Skeleton className="h-4 w-32" />
        </>
      )}
    </Dialog>
  );
}
