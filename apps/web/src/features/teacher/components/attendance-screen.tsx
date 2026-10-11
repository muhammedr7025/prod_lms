'use client';

import { teachingAttendanceContract, TEACH_SUBJECT_EXTRAS, type TeachAttendanceSession, type TeachRosterRow } from '@exatech/contracts';
import { ATTENDANCE_LABEL, attendanceCounts, nextAttendanceStatus } from '@exatech/domain';
import { Button, Card, cn, Corners, EmptyState, Field, Issue, Select, Skeleton, Tag, toast } from '@exatech/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { keyFor } from '@/lib/api';
import { useApi, useApiMutation } from '@/lib/hooks';
import { useAttendanceSync, type AttStatus } from '../hooks/use-attendance-sync';
import { CoverDialog } from './cover-dialog';
import { AnimatedCount, ScreenHeader } from './parts';
import { QrDialog } from './qr-dialog';

const OTHER = '__other';

const CHIP: Record<AttStatus | 'none', string> = {
  P: 'bg-accent-100 text-accent-800 border-accent-300',
  A: 'bg-ink text-white border-ink',
  L: 'bg-white text-ink border-ink',
  E: 'bg-neutral-100 text-neutral-700 border-divider',
  none: 'bg-white text-neutral-500 border-divider border-dashed',
};
const ROW_BG: Record<AttStatus | 'none', string> = { P: 'bg-white', A: 'bg-ink/[0.06]', L: 'bg-accent-100/40', E: 'bg-neutral-100/60', none: 'bg-white' };

function rowLabel(r: TeachRosterRow, status: AttStatus | null, submitted: boolean): string {
  if (!status) return 'Tap to mark';
  let label = ATTENDANCE_LABEL[status];
  if (r.source === 'qr' && status === r.status) label += ' · QR';
  if (status === 'A' && submitted && r.alerted) label += ' · parent alerted';
  return label;
}

/** Teacher · Attendance — session picker, subject taught, P/A/L/E counters, tap-to-cycle roster with offline autosave, submit. */
export function AttendanceScreen({ sessionId }: { sessionId?: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const query = sessionId ? { session: sessionId } : {};
  const { data, isPending, error } = useApi(teachingAttendanceContract.get, { query });
  const s = data?.session ?? null;
  const [coverOpen, setCoverOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

  const patch = useCallback(
    (applied: Record<string, AttStatus>, res: { savedAt: string }) => {
      qc.setQueryData(keyFor(teachingAttendanceContract.get, { query }), (old: { options: unknown[]; session: TeachAttendanceSession | null } | undefined) => {
        if (!old?.session) return old;
        const roster = old.session.roster.map((r) => (applied[r.enrollmentId] ? { ...r, status: applied[r.enrollmentId]!, source: 'teacher' as const } : r));
        const t = new Date(Date.parse(res.savedAt) + 330 * 60_000).toISOString().slice(11, 16);
        return { ...old, session: { ...old.session, roster, counts: attendanceCounts(roster.map((r) => r.status)), savedLabel: `Saved ${t}` } };
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [qc, sessionId],
  );
  const sync = useAttendanceSync(s?.sessionId ?? null, patch);

  const statusOf = useCallback((r: TeachRosterRow): AttStatus | null => (sync.overlay[r.enrollmentId] ?? r.status) as AttStatus | null, [sync.overlay]);
  const counts = useMemo(() => attendanceCounts((s?.roster ?? []).map((r) => statusOf(r))), [s, statusOf]);
  const unmarked = (s?.roster ?? []).filter((r) => !statusOf(r)).length;

  const submit = useApiMutation(teachingAttendanceContract.submit, {
    invalidate: [['teaching']],
    success: (d) => `Attendance submitted · ${d.present} present · ${d.absent} absent${d.alerted ? ` · ${d.alerted} parent alert${d.alerted > 1 ? 's' : ''} sent` : ''}`,
  });
  const [subjectDraft, setSubjectDraft] = useState<string | null>(null);
  const subject = useApiMutation(teachingAttendanceContract.subject, {
    invalidate: [['teaching', 'attendance']],
    success: (_d, a) =>
      a.body.subject === s?.assignedSubject
        ? `Subject taught · ${a.body.subject}`
        : (TEACH_SUBJECT_EXTRAS as readonly string[]).includes(a.body.subject)
          ? `Tagged ${a.body.subject} · syllabus log updated`
          : `Tagged ${a.body.subject} · subject teacher informed`,
    onSuccess: () => setSubjectDraft(null),
    onError: () => setSubjectDraft(null),
  });

  const pick = (id: string) => {
    if (id === OTHER) {
      setCoverOpen(true);
      return;
    }
    router.replace(`/teacher/attendance?session=${id}`);
  };

  const tap = (r: TeachRosterRow) => {
    if (!s?.canEdit) return;
    sync.set({ [r.enrollmentId]: nextAttendanceStatus(statusOf(r)) });
  };

  const markAll = () => {
    if (!s) return;
    const before: Record<string, AttStatus> = {};
    const changes: Record<string, AttStatus> = {};
    for (const r of s.roster) {
      const st = statusOf(r);
      if (st !== 'P') {
        changes[r.enrollmentId] = 'P';
        if (st) before[r.enrollmentId] = st;
      }
    }
    if (!Object.keys(changes).length) return;
    sync.set(changes);
    toast(`All ${s.roster.length} marked present`, Object.keys(before).length ? { undo: () => sync.set(before) } : {});
  };

  const doSubmit = async () => {
    if (!s) return;
    const synced = await sync.drain();
    if (!synced) {
      toast.error('Some taps have not synced yet — they will sync when you are back online');
      return;
    }
    submit.mutate({ params: { id: s.sessionId } });
  };

  const tag = !s ? null : sync.offline ? (
    <Tag variant="ink" data-testid="att-status">{`Offline · ${sync.queued} change${sync.queued === 1 ? '' : 's'} will sync`}</Tag>
  ) : s.submitted ? (
    <Tag variant="accent" data-testid="att-status">
      {s.submittedLabel}
    </Tag>
  ) : (
    <Tag variant="neutral" data-testid="att-status">
      {sync.saving || sync.queued ? 'Saving…' : s.savedLabel}
    </Tag>
  );

  const subjectNote = !s
    ? ''
    : (subjectDraft ?? s.subjectTaught) !== s.assignedSubject
      ? `Tagged ${subjectDraft ?? s.subjectTaught} (your subject here is ${s.assignedSubject}) — the subject teacher is informed and the syllabus log updated.`
      : 'A different subject tags the session, informs the subject teacher and updates the syllabus log.';

  return (
    <>
      <ScreenHeader label="Teacher · Attendance" kicker={s ? s.kicker : isPending ? null : 'No session selected'} title="Attendance" action={tag} />
      {error && <EmptyState title="Could not load attendance" body={error.message} />}
      {isPending && (
        <>
          <Skeleton className="h-[66px]" />
          <Skeleton className="h-[52px]" />
          <Skeleton className="h-[420px]" />
        </>
      )}
      {data && !s && (
        <Card tone="white" pad="none">
          <EmptyState
            className="py-6"
            title="No sessions to mark"
            body="You have no sessions today or in the last 48 hours. Taking a class that isn't on your timetable?"
            action={
              <Button variant="primary" size="lg" className="mt-2" onClick={() => setCoverOpen(true)}>
                Cover another class
              </Button>
            }
          />
        </Card>
      )}
      {s && data && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Batch · session">
              <Select tone="white" className="min-h-11" value={s.sessionId} onChange={(e) => pick(e.target.value)}>
                {data.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
                <option value={OTHER}>Another batch · cover / extra session…</option>
              </Select>
            </Field>
            <Field label="Subject taught">
              <Select
                tone="white"
                className="min-h-11"
                value={subjectDraft ?? s.subjectTaught}
                disabled={!s.canEdit || subject.isPending}
                onChange={(e) => {
                  setSubjectDraft(e.target.value);
                  subject.mutate({ params: { id: s.sessionId }, body: { subject: e.target.value } });
                }}
                options={s.subjectOptions}
              />
            </Field>
          </div>
          <div className="text-xs text-neutral-600">{subjectNote}</div>
          {s.adhocPending && <Issue kind="needed">Ad-hoc session — counts toward attendance once the Branch Admin acknowledges it</Issue>}

          <div className="grid grid-cols-4 gap-1.5" data-testid="att-counters">
            <Counter label="Present" value={counts.P} className="bg-accent-100 border-divider" blueprint />
            <Counter label="Absent" value={counts.A} className="bg-ink text-white border-ink" />
            <Counter label="Late" value={counts.L} className="bg-white border-divider" />
            <Counter label="Excused" value={counts.E} className="bg-white border-divider" />
          </div>

          {s.canEdit && (
            <div className="flex gap-1.5">
              <Button variant="secondary" size="lg" className="flex-1 bg-white" onClick={markAll}>
                Mark all present
              </Button>
              {s.date === new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) && (
                <Button variant="secondary" size="lg" className="bg-white" onClick={() => setQrOpen(true)}>
                  QR self check-in
                </Button>
              )}
            </div>
          )}
          {s.lockedReason && <Issue kind="blocked">{s.lockedReason}</Issue>}

          <Card tone="white" pad="none" className="min-w-0" data-testid="att-roster">
            {s.roster.length === 0 && <EmptyState title="Nobody on this roster" body="The batch has no active students." />}
            {s.roster.map((r) => {
              const st = statusOf(r);
              const key = st ?? 'none';
              return (
                <button
                  key={r.enrollmentId}
                  type="button"
                  onClick={() => tap(r)}
                  disabled={!s.canEdit}
                  aria-label={`${r.name}: ${st ? ATTENDANCE_LABEL[st] : 'not marked'}`}
                  data-testid="att-row"
                  className={cn(
                    'flex items-center gap-3 w-full min-h-[54px] px-3 py-2 border-0 border-b border-divider last:border-b-0 text-left cursor-pointer font-[inherit] text-[inherit] transition-[background-color,transform] duration-150 active:scale-[.995] motion-reduce:transition-none motion-reduce:active:scale-100 disabled:cursor-default',
                    ROW_BG[key],
                  )}
                >
                  <span className={cn('w-[34px] h-[34px] flex-none grid place-items-center font-heading font-semibold text-[15px] border transition-colors duration-150', CHIP[key])} data-testid="att-chip">
                    {st ?? '–'}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="font-medium text-sm">{r.name}</span>
                    <div className="text-[11px] text-neutral-600 font-mono">{r.admissionNo ?? '—'}</div>
                  </span>
                  <span className="text-xs text-neutral-600 text-right">{rowLabel(r, st, s.submitted)}</span>
                </button>
              );
            })}
          </Card>

          {!s.submitted && s.canEdit && (
            <>
              {unmarked > 0 && s.roster.length > 0 && <Issue kind="needed">{unmarked === s.roster.length ? 'Tap Mark all present, then mark the exceptions' : `${unmarked} student${unmarked > 1 ? 's' : ''} not marked yet`}</Issue>}
              <Button variant="primary" size="xl" blueprint disabled={unmarked > 0 || s.roster.length === 0} loading={submit.isPending} onClick={() => void doSubmit()}>
                Submit attendance · {counts.P} present · {counts.A} absent
              </Button>
            </>
          )}
          {s.submitted && s.canEdit && <div className="text-[13px] text-center text-accent-800">{s.submittedLabel} · taps save automatically while the {s.editWindowHours} h edit window is open.</div>}
          <div className="text-xs text-neutral-600 text-center">
            {s.roster.length} students · tap a row to cycle Present → Absent → Late → Excused. Submitting sends same-day absence alerts to parents. Edits allowed for {s.editWindowHours} h; later changes need admin override with a reason. Ad-hoc sessions count after the Branch Admin acknowledges them.
          </div>
          <QrDialog sessionId={s.sessionId} open={qrOpen} onOpenChange={setQrOpen} />
        </>
      )}
      <CoverDialog open={coverOpen} onOpenChange={setCoverOpen} onStarted={(id) => router.replace(`/teacher/attendance?session=${id}`)} />
    </>
  );
}

function Counter({ label, value, className, blueprint }: { label: string; value: number; className?: string; blueprint?: boolean }) {
  return (
    <div className={cn('relative p-2 text-center border', className)}>
      {blueprint && <Corners />}
      <div className="font-heading font-semibold text-2xl leading-none tabular">
        <AnimatedCount value={value} />
      </div>
      <div className="text-[11px]">{label}</div>
    </div>
  );
}
