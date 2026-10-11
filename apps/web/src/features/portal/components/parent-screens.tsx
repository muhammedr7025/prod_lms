'use client';

import { portalContract, PTM_PART_LABEL, PTM_PARTS, type PortalHome } from '@exatech/contracts';
import { Bar, Button, Card, CardButton, CardMeta, cn, Dialog, Field, Input, Issue, Kicker, Skeleton, Tag, Textarea } from '@exatech/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useMe } from '@/components/me-context';
import { useApi, useApiMutation } from '@/lib/hooks';
import { useChildSelection } from '../lib';
import { ChildSwitcher, ChoiceSeg, FeeCardView, LoadError, ScreenHeader } from './parts';
import { usePaySheet } from './use-pay-sheet';
import { FeesScreen } from './fees-screen';
import { MarksScreen } from './marks-screen';

function useParent() {
  const sel = useChildSelection();
  const switcher = <ChildSwitcher items={sel.items} selectedId={sel.studentId} onSelect={sel.select} />;
  const error = sel.error ? <LoadError what="your children" error={sel.error} /> : null;
  return { ...sel, switcher, error };
}

/** Parent · Home — per child: fees, attendance, latest marks, today, message teacher, PTM. */
export function ParentHome() {
  const p = useParent();
  const router = useRouter();
  const pay = usePaySheet();
  const { data, error, refetch } = useApi(portalContract.home, { query: { studentId: p.studentId } }, { enabled: !!p.studentId });
  const [msgOpen, setMsgOpen] = useState(false);
  const [ptmOpen, setPtmOpen] = useState(false);
  const q = p.studentId ? `?child=${p.studentId}` : '';
  const att = data?.attendance;
  return (
    <>
      {p.switcher}
      {p.error}
      <div data-screen-label="Parent · Home">
        <Kicker>{data?.student.batchLong ?? p.selected?.batchLong ?? <Skeleton className="h-3 w-52" />}</Kicker>
        <h2 className="m-0 text-[32px] leading-[1.12] tracking-[-0.015em]" data-testid="child-name">
          {data?.student.name ?? p.selected?.name ?? <Skeleton className="h-8 w-44 mt-1" />}
        </h2>
      </div>
      {error && !data && <LoadError what={p.selected?.firstName ?? 'this child'} error={error} onRetry={() => void refetch()} />}
      <FeeCardView fee={data?.fee} onPay={() => pay.open(data?.pay)} />
      <div className="grid grid-cols-2 gap-2.5">
        <CardButton tone={att?.low ? 'ink' : 'white'} className="p-3.5 gap-0.5" onClick={() => router.push(`/parent/attendance${q}`)} data-testid="attendance-tile" data-low={att?.low ? 'true' : 'false'}>
          <Kicker className={att?.low ? 'text-ink' : undefined}>Attendance</Kicker>
          <div className="font-heading font-semibold text-[30px] leading-none tabular">{att ? `${att.pct}%` : <Skeleton className="h-[30px] w-14" />}</div>
          <CardMeta className={att?.low ? 'text-ink font-medium' : undefined}>{att?.note ?? '…'}</CardMeta>
        </CardButton>
        <CardButton className="p-3.5 gap-0.5" onClick={() => router.push(`/parent/marks${q}`)}>
          <Kicker>Latest marks</Kicker>
          <div className="font-heading font-semibold text-[30px] leading-none tabular">{data ? (data.latestMarks?.score ?? '—') : <Skeleton className="h-[30px] w-14" />}</div>
          <CardMeta>{data ? (data.latestMarks?.label ?? 'none published yet') : '…'}</CardMeta>
        </CardButton>
      </div>
      <Card className={cn('p-3.5 gap-1.5', data?.today.tone === 'absent' && 'border-ink')} data-testid="today-card">
        <Kicker className={data?.today.tone === 'absent' ? 'text-ink' : undefined}>Today</Kicker>
        <div className="text-sm font-medium">{data?.today.title ?? <Skeleton className="h-4 w-48" />}</div>
        <div className="text-xs text-neutral-600">{data?.today.sub}</div>
      </Card>
      <div className="flex gap-1.5">
        <Button size="lg" className="flex-1 whitespace-normal" disabled={!data} onClick={() => setMsgOpen(true)}>
          Message class teacher
        </Button>
        <Button size="lg" className="flex-1 whitespace-normal" disabled={!data} onClick={() => setPtmOpen(true)}>
          Request PTM slot
        </Button>
      </div>
      {data && <MessageDialog open={msgOpen} onOpenChange={setMsgOpen} home={data} />}
      {data && <PtmDialog open={ptmOpen} onOpenChange={setPtmOpen} home={data} />}
      {pay.element}
    </>
  );
}

function MessageDialog({ open, onOpenChange, home }: { open: boolean; onOpenChange: (o: boolean) => void; home: PortalHome }) {
  const me = useMe();
  const [body, setBody] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const send = useApiMutation(portalContract.messageTeacher, {
    success: (r) => r.note,
    toastError: false,
    onSuccess: () => {
      setBody('');
      setErr(null);
      onOpenChange(false);
    },
    onError: (e) => setErr(e.fields?.body ?? e.message),
  });
  const teachers = home.contact.teacherNames.join(', ') || 'the class teacher';
  const short = body.trim().length < 10;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      kicker={`${home.student.firstName} · ${home.student.batchCode}`}
      title="Message class teacher"
      footer={
        <>
          <Button size="lg" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" disabled={short || me.readOnly} loading={send.isPending} onClick={() => send.mutate({ body: { studentId: home.student.studentId, body: body.trim() } })}>
            Send message
          </Button>
        </>
      }
    >
      <Field label={`To ${teachers}`} error={err}>
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={1000} placeholder={`How is ${home.student.firstName} doing this week?`} />
      </Field>
      <div className="text-xs text-neutral-600">
        Messages are moderated and delivered during staff hours ({home.contact.staffHours}). {short ? 'Write at least a sentence to send.' : `${body.trim().length} / 1000`}
      </div>
      {me.readOnly && <Issue kind="blocked">You are viewing as this user (read-only) — messages cannot be sent</Issue>}
    </Dialog>
  );
}

function tomorrowIST(): string {
  return new Date(Date.now() + 330 * 60_000 + 86_400_000).toISOString().slice(0, 10);
}
function plusDaysIST(n: number): string {
  return new Date(Date.now() + 330 * 60_000 + n * 86_400_000).toISOString().slice(0, 10);
}

function PtmDialog({ open, onOpenChange, home }: { open: boolean; onOpenChange: (o: boolean) => void; home: PortalHome }) {
  const me = useMe();
  const [date, setDate] = useState(tomorrowIST());
  const [part, setPart] = useState<(typeof PTM_PARTS)[number]>('morning');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const req = useApiMutation(portalContract.requestPtm, {
    success: (r) => r.note,
    toastError: false,
    onSuccess: () => {
      setNote('');
      setErr(null);
      onOpenChange(false);
    },
    onError: (e) => setErr(e.message),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      kicker={`${home.student.firstName} · ${home.student.batchCode}`}
      title="Request PTM slot"
      footer={
        <>
          <Button size="lg" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" disabled={!date || me.readOnly} loading={req.isPending} onClick={() => req.mutate({ body: { studentId: home.student.studentId, date, part, note: note.trim() || undefined } })}>
            Request slot
          </Button>
        </>
      }
    >
      <Field label="Preferred date">
        <Input type="date" value={date} min={tomorrowIST()} max={plusDaysIST(60)} onChange={(e) => setDate(e.target.value)} className="min-h-11" />
      </Field>
      <div className="grid gap-[5px]">
        <span className="text-xs text-ink/70">Part of day</span>
        <ChoiceSeg
          label="Part of day"
          value={part}
          onChange={setPart}
          options={PTM_PARTS.map((p) => {
            const [top, bottom] = PTM_PART_LABEL[p].split(' (');
            return { value: p, top: top!, bottom: bottom ? bottom.replace(')', '') : undefined };
          })}
        />
      </div>
      <Field label="Note for the teacher (optional)">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="What would you like to discuss?" className="min-h-[70px]" />
      </Field>
      <div className="text-xs text-neutral-600">{home.contact.teacherNames.join(', ') || 'The class teacher'} and the branch office are notified; the teacher confirms the exact time.</div>
      {err && <Issue kind="blocked">{err}</Issue>}
      {me.readOnly && <Issue kind="blocked">You are viewing as this user (read-only) — requests cannot be sent</Issue>}
    </Dialog>
  );
}

/** Parent · Attendance — % with threshold bar (ink below threshold) and same-day history. */
export function ParentAttendance() {
  const p = useParent();
  const { data, error, isPending, refetch } = useApi(portalContract.attendance, { query: { studentId: p.studentId } }, { enabled: !!p.studentId });
  return (
    <>
      {p.switcher}
      {p.error}
      <ScreenHeader label="Parent · Attendance" kicker={data?.kicker} title={data ? `Attendance · ${data.pct}%` : undefined} />
      {data ? (
        <div data-testid="attendance-bar" data-low={data.low ? 'true' : 'false'}>
          <Bar value={data.pct} height={8} tone={data.low ? 'ink' : 'accent'} />
          {data.low && <div className="text-xs text-ink font-medium mt-1">Below the {data.threshold}% threshold</div>}
        </div>
      ) : (
        <Skeleton className="h-2" />
      )}
      {error && !data && <LoadError what="attendance" error={error} onRetry={() => void refetch()} />}
      {(isPending || !p.studentId) && !data && <Skeleton className="h-[280px]" />}
      {data && (
        <Card pad="none">
          {data.history.length === 0 && <div className="px-4 py-6 text-center text-[13px] text-neutral-600">No sessions marked yet.</div>}
          {data.history.map((h) => (
            <div key={h.id} className="flex justify-between items-center gap-2 px-3 py-2.5 min-h-12 border-b border-divider last:border-b-0" data-testid="attendance-row">
              <div className="min-w-0">
                <div className="text-sm font-medium">{h.dateLabel}</div>
                <div className="text-xs text-neutral-600">{h.topic}</div>
              </div>
              <Tag variant={h.tagVariant} className="flex-none">
                {h.label}
              </Tag>
            </div>
          ))}
        </Card>
      )}
      {data && <div className="text-xs text-neutral-600 text-center">{data.footer}</div>}
    </>
  );
}

export function ParentMarks() {
  const p = useParent();
  return (
    <>
      {p.switcher}
      {p.error}
      <MarksScreen studentId={p.studentId} label="Parent · Marks" />
    </>
  );
}

export function ParentFees() {
  const p = useParent();
  return (
    <>
      {p.switcher}
      {p.error}
      <FeesScreen studentId={p.studentId} label="Parent · Fees" siblings={p.items} />
    </>
  );
}

/** Parent · Alerts — notifications for every child (absence & overdue in ink) and channel rules. */
export function ParentAlerts() {
  const p = useParent();
  const { data, error, isPending, refetch } = useApi(portalContract.alerts, {});
  return (
    <>
      {p.switcher}
      {p.error}
      <ScreenHeader label="Parent · Alerts" kicker={data?.kicker} title="Alerts" />
      {error && !data && <LoadError what="alerts" error={error} onRetry={() => void refetch()} />}
      {isPending && !data && Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-[84px]" />)}
      {data && data.items.length === 0 && (
        <Card pad="none">
          <div className="px-4 py-6 text-center text-[13px] text-neutral-600">No alerts yet — absences, dues, payments and marks appear here.</div>
        </Card>
      )}
      {data?.items.map((a) => {
        const inner = (
          <>
            <div className="flex justify-between items-center gap-2">
              <Tag variant={a.tagVariant}>{a.kind}</Tag>
              <span className="text-[11px] text-neutral-500">{a.when}</span>
            </div>
            <div className="text-sm font-medium">{a.title}</div>
            <div className="text-[13px] text-neutral-700">{a.body}</div>
          </>
        );
        return a.link ? (
          <Link key={a.id} href={a.link} className="no-underline text-ink" data-testid="alert-card" data-kind={a.kind}>
            <Card tone={a.attention ? 'ink' : 'white'} className="px-3.5 py-3 gap-1 hover:bg-accent-100">
              {inner}
            </Card>
          </Link>
        ) : (
          <Card key={a.id} tone={a.attention ? 'ink' : 'white'} className="px-3.5 py-3 gap-1" data-testid="alert-card" data-kind={a.kind}>
            {inner}
          </Card>
        );
      })}
      {data && (
        <Card tone="line" className="p-3.5 gap-2">
          <div className="flex justify-between items-center gap-2">
            <div className="font-heading font-semibold text-[17px]">Channels</div>
            <Link href="/account/notifications" className="text-[13px] text-accent-800 underline underline-offset-[3px] min-h-11 inline-flex items-center">
              Change
            </Link>
          </div>
          <div className="grid gap-1.5 text-[13px]">
            {data.channels.map((c) => (
              <div key={c.label} className="flex justify-between items-center gap-2">
                <span>{c.label}</span>
                <Tag variant={c.tagVariant}>{c.value}</Tag>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
