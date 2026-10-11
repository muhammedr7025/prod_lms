'use client';

import { academicsOverviewContract, academicsTimetableContract, type AcadLeaveRow } from '@exatech/contracts';
import { Button, Card, CardTitle, Dialog, EmptyState, Field, Grid, Page, PageHeader, Skeleton, Stat, Tag, Textarea } from '@exatech/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useDrawer } from '@/components/drawers/drawer-context';
import { useCan } from '@/components/me-context';
import { useApi, useApiMutation } from '@/lib/hooks';
import { ParentRequestsCard } from '@/features/comms/parent-requests-card';

/** Branch Administrator · Overview — today's sessions, KPIs, at-risk students, leave and ad-hoc acknowledgement. */
export function BranchOpsScreen() {
  const { data, isPending, error } = useApi(academicsOverviewContract.overview, {}, { refetchInterval: 60_000 });
  const router = useRouter();
  const drawer = useDrawer();
  const canBatch = useCan('academics:courses.manage');
  const canAnnounce = useCan('comms:announcements.manage');
  const [rejecting, setRejecting] = useState<AcadLeaveRow | null>(null);
  const [note, setNote] = useState('');
  const ack = useApiMutation(academicsTimetableContract.acknowledge, { invalidate: [['academics']], success: 'Ad-hoc session acknowledged · attendance now counts' });
  const decide = useApiMutation(academicsOverviewContract.decideLeave, {
    invalidate: [['academics']],
    success: (_d, a) => (a.body.decision === 'approved' ? 'Leave approved · sessions flagged for a substitute' : 'Leave rejected · teacher notified'),
    onSuccess: () => {
      setRejecting(null);
      setNote('');
    },
  });

  const k = data?.kpis;
  return (
    <Page label="Branch Admin · Overview">
      <PageHeader
        kicker={data ? `${data.branchLabel} · ${data.dateLabel}` : <Skeleton className="h-3 w-40" />}
        title="Branch operations"
        actions={
          <>
            {canAnnounce && (
              <Button variant="secondary" onClick={() => router.push('/announcements')}>
                Announce
              </Button>
            )}
            {canBatch && (
              <Button variant="primary" onClick={() => router.push('/batches?new=1')}>
                New batch
              </Button>
            )}
          </>
        }
      />
      {error && <EmptyState title="Could not load branch operations" body={error.message} />}
      <Grid min={160}>
        {isPending || !k ? (
          Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[92px]" />)
        ) : (
          <>
            <Stat label="Sessions today" value={k.sessionsToday} meta={`${k.sessionsMarked} of ${k.sessionsToday} marked`} onClick={() => router.push('/timetable')} />
            <Stat label="Running batches" value={k.runningBatches} meta={`${k.activeStudents} active students`} onClick={() => router.push('/batches')} />
            <Stat label="Admissions pending" value={k.admissionsPending} meta="awaiting your approval" onClick={() => router.push('/admissions')} />
            <Stat label="Marks to publish" value={k.marksToPublish} meta="submitted by teachers" onClick={() => router.push('/marks-publishing')} />
            <Stat label="At-risk students" value={k.atRisk} meta="attendance + dues + missed work" emphasis={k.atRisk > 0} />
          </>
        )}
      </Grid>

      <Grid min={300}>
        <Card pad="lg" className="gap-2">
          <div className="flex justify-between items-center">
            <CardTitle>Today&apos;s sessions</CardTitle>
            <Link href="/timetable" className="text-xs text-accent-800 underline underline-offset-[3px]">
              Timetable
            </Link>
          </div>
          {isPending && Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-11" />)}
          {data?.sessions.length === 0 && <EmptyState className="py-5" title="No sessions today" body="Holidays and weekends suppress sessions. Ad-hoc sessions teachers start appear here for acknowledgement." />}
          {data?.sessions.map((x, i) => (
            <div key={x.id} className={`grid grid-cols-[86px_1fr_auto] gap-2.5 items-center text-[13px] py-2 ${i < data.sessions.length - 1 ? 'border-b border-divider' : ''}`} data-testid="today-session">
              <span className="tabular text-neutral-600">{x.time}</span>
              <span className="min-w-0">
                <b className="font-medium">{x.batchCode}</b> · {x.topic}
                <div className="text-xs text-neutral-600">
                  {x.teacherName} · {x.roomName}
                  {x.adhocNote ? ` · ${x.adhocNote}` : ''}
                </div>
              </span>
              <span className="flex items-center gap-1.5 justify-end">
                <Tag variant={x.tag}>{x.statusLabel}</Tag>
                {x.canAcknowledge && (
                  <Button size="sm" variant="primary" loading={ack.isPending && ack.variables?.params.id === x.id} onClick={() => ack.mutate({ params: { id: x.id } })}>
                    Acknowledge
                  </Button>
                )}
              </span>
            </div>
          ))}
        </Card>

        <Card pad="lg" className="gap-2">
          <div className="flex justify-between items-center">
            <CardTitle>At-risk this week</CardTitle>
            <Tag variant="neutral">Phase 2 signal</Tag>
          </div>
          {isPending && Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-11" />)}
          {data?.atRisk.length === 0 && <EmptyState className="py-5" title="Nobody at risk" body="Attendance below 75 %, overdue fees with missed work, or 3 absences in a row raise a flag here." />}
          <div className="grid gap-1.5 text-[13px]">
            {data?.atRisk.map((r, i) => (
              <div key={r.studentId} className={`flex justify-between items-center gap-2 py-2 ${i < data.atRisk.length - 1 ? 'border-b border-divider' : ''}`}>
                <div className="min-w-0">
                  <b className="font-medium">{r.name}</b> · {r.batchCode}
                  <div className="text-xs text-neutral-600">{r.reasons.join(' · ')}</div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => drawer.open('student', r.studentId)} aria-label={`Open ${r.name}`}>
                  Open
                </Button>
              </div>
            ))}
          </div>
        </Card>

        {data && data.leave.length > 0 && (
          <Card pad="lg" className="gap-2">
            <div className="flex justify-between items-center">
              <CardTitle>Leave requests</CardTitle>
              <Tag variant="ink">{data.leave.length} pending</Tag>
            </div>
            <div className="grid text-[13px]">
              {data.leave.map((l, i) => (
                <div key={l.id} className={`grid gap-1.5 py-2 ${i < data.leave.length - 1 ? 'border-b border-divider' : ''}`} data-testid="leave-row">
                  <div className="flex justify-between gap-2">
                    <span>
                      <b className="font-medium">{l.userName}</b> · {l.dateLabel}
                    </span>
                    <Tag variant="outline">{l.type}</Tag>
                  </div>
                  <div className="text-xs text-neutral-600">
                    {l.reason ? `${l.reason} · ` : ''}
                    {l.impact}
                  </div>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="primary" loading={decide.isPending && decide.variables?.params.id === l.id && decide.variables.body.decision === 'approved'} onClick={() => decide.mutate({ params: { id: l.id }, body: { decision: 'approved' } })}>
                      Approve
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setRejecting(l)}>
                      Reject
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </Grid>

      <ParentRequestsCard />

      <Dialog
        open={!!rejecting}
        onOpenChange={(o) => !o && setRejecting(null)}
        kicker="Leave"
        title={rejecting ? `Reject leave · ${rejecting.userName} · ${rejecting.dateLabel}` : 'Reject leave'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRejecting(null)}>
              Cancel
            </Button>
            <Button variant="primary" loading={decide.isPending} onClick={() => rejecting && decide.mutate({ params: { id: rejecting.id }, body: { decision: 'rejected', note: note.trim() || undefined } })}>
              Reject leave
            </Button>
          </>
        }
      >
        <Field label="Note to the teacher (optional)">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Exam week — please swap with another day" />
        </Field>
      </Dialog>
    </Page>
  );
}
