'use client';

import { checkinContract, commsContract, portalContract, type AnnouncementFeedItem } from '@exatech/contracts';
import { Button, Card, CardButton, CardMeta, Dialog, Icon, Input, Issue, Kicker, Skeleton, toast } from '@exatech/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useMe } from '@/components/me-context';
import { callApi } from '@/lib/api';
import { invalidatePrefixes, useApi, useApiMutation } from '@/lib/hooks';
import { FeeCardView, LoadError } from './parts';
import { usePaySheet } from './pay-sheet';

/** Student · Home — fee card, attendance ring + next session, pending work, upcoming exam, announcement, QR check-in. */
export function StudentHome() {
  const { data, error, refetch } = useApi(portalContract.home, { query: {} });
  const router = useRouter();
  const pay = usePaySheet();
  const att = data?.attendance;

  return (
    <>
      <div data-screen-label="Student · Home">
        <Kicker>{data?.student.kicker ?? <Skeleton className="h-3 w-56" />}</Kicker>
        <h2 className="m-0 text-[32px] leading-[1.12] tracking-[-0.015em]">{data ? `Hi, ${data.student.firstName}` : <Skeleton className="h-8 w-40 mt-1" />}</h2>
      </div>
      {error && !data && <LoadError what="your home screen" error={error} onRetry={() => void refetch()} />}

      <FeeCardView fee={data?.fee} onPay={() => pay.open(data?.pay)} />

      {att ? (
        <Card className="p-3.5 grid grid-cols-[auto_1fr] gap-3 items-center" data-testid="attendance-card">
          <AttendanceRing pct={att.pct} low={att.low} />
          <div className="min-w-0">
            <Kicker className={att.low ? 'text-ink' : undefined}>Attendance</Kicker>
            <div className="text-sm">{att.line}</div>
            <div className="text-xs text-neutral-600">{att.next ?? 'No upcoming sessions scheduled'}</div>
          </div>
        </Card>
      ) : (
        <Skeleton className="h-[112px]" />
      )}

      <div className="grid grid-cols-2 gap-2.5">
        <CardButton className="p-3.5 gap-0.5" onClick={() => router.push('/student/work')} data-testid="pending-work">
          <Kicker>Pending work</Kicker>
          <div className="font-heading font-semibold text-[30px] leading-none tabular">{data ? data.pendingWork.count : <Skeleton className="h-[30px] w-10" />}</div>
          <CardMeta>{data?.pendingWork.note ?? '…'}</CardMeta>
        </CardButton>
        <Card className="p-3.5 gap-0.5">
          <Kicker>Upcoming exam</Kicker>
          <div className="font-heading font-semibold text-[30px] leading-none">{data ? (data.upcomingExam?.day ?? '—') : <Skeleton className="h-[30px] w-12" />}</div>
          <CardMeta>{data ? (data.upcomingExam?.label ?? 'none scheduled') : '…'}</CardMeta>
        </Card>
      </div>

      <AnnouncementCard />
      <CheckInCard />
      {pay.element}
    </>
  );
}

/** Conic-gradient ring (84 px) with the % in the middle; ink when below the threshold. */
export function AttendanceRing({ pct, low }: { pct: number; low: boolean }) {
  const color = low ? 'var(--color-ink)' : 'var(--color-accent)';
  return (
    <div
      className="w-[84px] h-[84px] rounded-full grid place-items-center"
      style={{ background: `conic-gradient(${color} ${pct}%, var(--color-accent-100) 0)` }}
      role="img"
      aria-label={`Attendance ${pct}%`}
    >
      <div className="w-16 h-16 rounded-full bg-white grid place-items-center font-heading font-semibold text-xl tabular">{pct}%</div>
    </div>
  );
}

/** Latest announcement (an unacknowledged "ack required" one first); marks it read when shown. */
export function AnnouncementCard() {
  const me = useMe();
  const qc = useQueryClient();
  const feed = useApi(commsContract.feed, {});
  const items = feed.data?.items ?? [];
  const item: AnnouncementFeedItem | undefined = items.find((i) => i.ackRequired && !i.ackedAt) ?? items[0];
  const marked = useRef(new Set<string>());
  const ack = useApiMutation(commsContract.ack, { invalidate: [['comms']], success: 'Acknowledged' });

  useEffect(() => {
    if (!item || item.readAt || me.readOnly || marked.current.has(item.id)) return;
    marked.current.add(item.id);
    callApi(commsContract.read, { params: { id: item.id } })
      .then(() => invalidatePrefixes(qc, [['comms']]))
      .catch(() => undefined);
  }, [item, me.readOnly, qc]);

  if (feed.isPending) return <Skeleton className="h-[96px]" />;
  if (feed.error) return <LoadError what="announcements" error={feed.error} onRetry={() => void feed.refetch()} />;
  if (!item)
    return (
      <Card className="p-3.5 gap-1">
        <Kicker>Announcement</Kicker>
        <div className="text-[13px] text-neutral-600">No announcements for your batch yet.</div>
      </Card>
    );
  const needsAck = item.ackRequired && !item.ackedAt;
  return (
    <Card className="p-3.5 gap-1.5" data-testid="announcement-card">
      <div className="flex justify-between gap-2">
        <Kicker>Announcement · {item.kicker}</Kicker>
        <span className="text-[11px] text-neutral-500 flex-none">{needsAck ? 'Please acknowledge' : 'Latest'}</span>
      </div>
      <div className="text-sm font-medium">{item.title}</div>
      <div className="text-[13px] text-neutral-700 whitespace-pre-line">{item.body}</div>
      {needsAck ? (
        <Button variant="primary" size="lg" className="mt-1" loading={ack.isPending} disabled={me.readOnly} onClick={() => ack.mutate({ params: { id: item.id } })}>
          Acknowledge
        </Button>
      ) : (
        item.ackRequired && <div className="text-xs text-accent-800">Acknowledged</div>
      )}
      {needsAck && me.readOnly && <div className="text-xs text-neutral-600">Read-only view — acknowledging is disabled.</div>}
    </Card>
  );
}

interface Detector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

function detectorCtor(): DetectorCtor | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector ?? null;
}

/** QR self check-in: type the teacher's rotating code, or scan it with the camera (BarcodeDetector). */
export function CheckInCard() {
  const me = useMe();
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [canScan, setCanScan] = useState(false);
  useEffect(() => setCanScan(!!detectorCtor() && !!navigator.mediaDevices?.getUserMedia), []);
  const check = useApiMutation(checkinContract.checkIn, {
    invalidate: [['portal']],
    toastError: false,
    success: false,
    onSuccess: (r) => {
      const parts = r.sessionLabel.split(' · ');
      const where = `${parts[0] ?? ''} ${parts[parts.length - 1] ?? ''}`.trim();
      toast(r.alreadyMarked ? `Already marked ${r.status === 'L' ? 'late' : 'present'} · ${where}` : `Marked ${r.status === 'L' ? 'late' : 'present'} · ${where}`);
      setCode('');
      setErr(null);
    },
    onError: (e) => setErr(e.message),
  });
  const submit = (value: string) => {
    const v = value.trim();
    if (v.length < 4) return setErr('Enter the code your teacher shows');
    setErr(null);
    check.mutate({ body: { code: v } });
  };
  return (
    <Card className="p-3.5 gap-2.5" data-testid="checkin-card">
      <div>
        <Kicker>Check in to class</Kicker>
        <div className="text-[13px] text-neutral-700">Enter the code your teacher shows{canScan ? ' — or scan the QR' : ''}. Codes rotate every 5 minutes.</div>
      </div>
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          submit(code);
        }}
      >
        <Input aria-label="Check-in code" placeholder="EXA-XXXX-XX" autoCapitalize="characters" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="min-h-11 font-mono flex-1" invalid={!!err} />
        <Button type="submit" variant="primary" size="lg" loading={check.isPending} disabled={me.readOnly}>
          Check in
        </Button>
      </form>
      {canScan && (
        <Button size="lg" onClick={() => setScanOpen(true)} disabled={me.readOnly}>
          <Icon name="scan" /> Scan QR with camera
        </Button>
      )}
      {err && <Issue kind="blocked">{err}</Issue>}
      {me.readOnly && <div className="text-xs text-neutral-600">Read-only view — check-in is disabled.</div>}
      <ScanDialog
        open={scanOpen}
        onOpenChange={setScanOpen}
        onCode={(v) => {
          setScanOpen(false);
          setCode(v.toUpperCase());
          submit(v);
        }}
      />
    </Card>
  );
}

function ScanDialog({ open, onOpenChange, onCode }: { open: boolean; onOpenChange: (o: boolean) => void; onCode: (v: string) => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;
  useEffect(() => {
    if (!open) return;
    const Ctor = detectorCtor();
    if (!Ctor) return;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    const detector = new Ctor({ formats: ['qr_code'] });
    setErr(null);
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(async (s) => {
        if (stopped) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = s;
        await v.play().catch(() => undefined);
        timer = setInterval(async () => {
          if (!videoRef.current || videoRef.current.readyState < 2) return;
          try {
            const found = await detector.detect(videoRef.current);
            const raw = found[0]?.rawValue;
            if (raw && !stopped) {
              stopped = true;
              onCodeRef.current(raw);
            }
          } catch {
            /* keep scanning */
          }
        }, 300);
      })
      .catch(() => setErr('The camera is not available — type the code instead'));
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} kicker="Check in to class" title="Scan the class QR" footer={<Button size="lg" onClick={() => onOpenChange(false)}>Cancel</Button>}>
      <video ref={videoRef} muted playsInline className="w-full aspect-square object-cover bg-ink" aria-label="Camera preview" />
      <div className="text-xs text-neutral-600">Point the camera at the QR on your teacher&apos;s screen.</div>
      {err && <Issue kind="blocked">{err}</Issue>}
    </Dialog>
  );
}
