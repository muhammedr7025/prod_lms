'use client';

import { teachingTodayContract, type TeachTodaySession } from '@exatech/contracts';
import { Button, Card, CardButton, CardMeta, CardTitle, EmptyState, Icon, Kicker, Skeleton, Tag } from '@exatech/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useApi } from '@/lib/hooks';
import { CoverDialog } from './cover-dialog';
import { LeaveDialog } from './leave-dialog';
import { ParentRequestsCard } from '@/features/comms/parent-requests-card';

/** Teacher · Today — sessions with live marked counts, ad-hoc cards, cover, to-grade / marks tiles, leave. */
export function TodayScreen() {
  const { data, isPending, error } = useApi(teachingTodayContract.today, {}, { refetchInterval: 60_000 });
  const router = useRouter();
  const [coverOpen, setCoverOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const goAttendance = (id: string) => router.push(`/teacher/attendance?session=${id}`);

  return (
    <>
      <div data-screen-label="Teacher · Today">
        <Kicker>{data?.dateLabel ?? <Skeleton className="h-3 w-28" />}</Kicker>
        <h2 className="m-0 text-[32px] leading-[1.12] tracking-[-0.015em]">{data?.greeting ?? <Skeleton className="h-8 w-56 mt-1" />}</h2>
      </div>

      {error && <EmptyState title="Could not load today" body={error.message} />}
      {isPending && Array.from({ length: 2 }, (_, i) => <Skeleton key={i} className="h-[118px]" />)}

      {data?.sessions.map((x) => <SessionCard key={x.id} s={x} onAttendance={goAttendance} onNotes={(batchId) => router.push(`/teacher/notes?batch=${batchId}`)} />)}
      {data?.emptyNote && (
        <Card tone="white" pad="none">
          <EmptyState className="py-6" title={data.emptyNote.split(' · ')[0]} body={data.emptyNote.split(' · ').slice(1).join(' · ')} />
        </Card>
      )}

      {data?.adhoc.map((x) => (
        <Card key={x.id} tone="white" className="p-3.5 gap-2 border-dashed" data-testid="teacher-adhoc">
          <div className="flex justify-between items-center gap-2">
            <div className="min-w-0">
              <Kicker>{x.kicker}</Kicker>
              <CardTitle>{x.title}</CardTitle>
            </div>
            <Tag variant="outline">{x.tag}</Tag>
          </div>
          <Button variant="secondary" size="lg" onClick={() => goAttendance(x.id)}>
            {x.marked > 0 ? 'Edit attendance' : 'Mark attendance'}
          </Button>
          {x.adhocPending && <div className="text-xs text-neutral-600">Counts toward attendance once the Branch Admin acknowledges it.</div>}
        </Card>
      ))}

      <CardButton tone="dashed" className="px-3.5 py-3 gap-0.5" onClick={() => setCoverOpen(true)}>
        <div className="flex justify-between items-center gap-2">
          <div>
            <div className="font-medium text-sm">Taking a class that isn&apos;t on your timetable?</div>
            <div className="text-xs text-neutral-600">Cover another batch, run an extra or doubt-clearing session — roster loads, Branch Admin is notified.</div>
          </div>
          <Icon name="arrowRight" size={16} className="flex-none" />
        </div>
      </CardButton>

      <div className="grid grid-cols-2 gap-2.5">
        <CardButton tone="white" className="p-3.5 gap-0.5" onClick={() => router.push('/teacher/assignments')}>
          <Kicker>To grade</Kicker>
          <div className="font-heading font-semibold text-[30px] leading-none tabular">{data ? data.toGrade : <Skeleton className="h-[30px] w-10" />}</div>
          <CardMeta>submissions across batches</CardMeta>
        </CardButton>
        <CardButton tone="white" className="p-3.5 gap-0.5" onClick={() => router.push('/teacher/marks')}>
          <Kicker>Marks</Kicker>
          <div className="font-heading font-semibold text-[30px] leading-none tabular">{data ? data.marksMissing : <Skeleton className="h-[30px] w-10" />}</div>
          <CardMeta>{data ? (data.marksMissing ? `missing ${data.marksMissingNote}` : data.marksMissingNote) : 'missing marks'}</CardMeta>
        </CardButton>
      </div>

      <Card tone="white" className="p-3.5 gap-2" data-testid="teacher-leave">
        <div className="flex justify-between items-center">
          <Kicker>Leave</Kicker>
          {data?.canRequestLeave !== false && (
            <Button variant="secondary" className="min-h-11" onClick={() => setLeaveOpen(true)}>
              Request leave
            </Button>
          )}
        </div>
        {data?.leaves.length === 0 && <div className="text-[13px] text-neutral-600 border-t border-divider pt-2">No leave on record. Requests go to your Branch Admin for approval.</div>}
        {data?.leaves.map((l) => (
          <div key={l.id} className="flex justify-between gap-2 py-1.5 border-t border-divider text-[13px]" data-testid="leave-row">
            <span className="min-w-0">
              {l.title}
              <div className="text-[11px] text-neutral-600">{l.sub}</div>
            </span>
            <Tag variant={l.tag} className="self-start">
              {l.statusLabel}
            </Tag>
          </div>
        ))}
      </Card>

      <ParentRequestsCard compact />

      <CoverDialog open={coverOpen} onOpenChange={setCoverOpen} onStarted={goAttendance} />
      <LeaveDialog open={leaveOpen} onOpenChange={setLeaveOpen} />
    </>
  );
}

function SessionCard({ s, onAttendance, onNotes }: { s: TeachTodaySession; onAttendance: (id: string) => void; onNotes: (batchId: string) => void }) {
  return (
    <Card tone={s.primary ? 'accent' : 'white'} className="p-3.5 gap-2" data-testid="teacher-session">
      <div className="flex justify-between items-center gap-2">
        <div className="min-w-0">
          <Kicker>{s.kicker}</Kicker>
          <CardTitle>{s.title}</CardTitle>
        </div>
        <Tag variant={s.tagVariant}>{s.tag}</Tag>
      </div>
      {s.primary ? (
        <>
          <Button variant="primary" size="xl" blueprint onClick={() => onAttendance(s.id)}>
            Mark attendance
          </Button>
          <div className="text-xs text-neutral-600">{s.rosterLine}</div>
        </>
      ) : (
        <div className="flex gap-1.5">
          <Button variant="secondary" size="lg" className="flex-1" onClick={() => onAttendance(s.id)}>
            {s.submitted ? 'Edit attendance' : 'Mark attendance'}
          </Button>
          <Button variant="secondary" size="lg" className="flex-1" onClick={() => onNotes(s.batchId)}>
            Notes
          </Button>
        </div>
      )}
    </Card>
  );
}
