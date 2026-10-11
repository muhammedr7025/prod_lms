'use client';

import { institutionStaffContract } from '@exatech/contracts';
import { formatRelative } from '@exatech/domain';
import { Button, Card, CardTitle, EmptyState, Kicker, Table, TableScroll, Tag, TD, TH, cn } from '@exatech/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { DrawerLayout, DrawerLoading } from '@/components/drawers/drawer-host';
import { useDrawer } from '@/components/drawers/drawer-context';
import { useCan } from '@/components/me-context';
import { DrawerKpi, Facts } from '@/features/institution';
import { useApi, useApiMutation } from '@/lib/hooks';
import { AssignDialog, EditMembershipsDialog, RecordLeaveDialog, StatusDialog } from './components/staff-dialogs';

type DialogKey = 'assign' | 'memberships' | 'leave' | 'status' | null;

/** Teacher / staff panel: KPIs, actions, memberships, teaching, this week, details, leave, materials, sessions & devices. */
export default function TeacherDrawer({ id }: { id: string }) {
  const { data, isPending, error } = useApi(institutionStaffContract.get, { params: { id } });
  const router = useRouter();
  const drawer = useDrawer();
  const canTimetable = useCan('academics:timetable.read', 'academics:timetable.manage');
  const [dialog, setDialog] = useState<DialogKey>(null);
  const signOut = useApiMutation(institutionStaffContract.signOutEverywhere, {
    invalidate: [['institution', 'staff']],
    success: (r) => `Signed out of ${r.signedOut} session${r.signedOut === 1 ? '' : 's'}`,
  });

  if (isPending) return <DrawerLoading />;
  if (error || !data)
    return (
      <DrawerLayout kicker="Staff member" title="Staff member">
        <EmptyState title="Could not load this person" body={error?.message} />
      </DrawerLayout>
    );

  const k = data.kpis;
  const close = () => setDialog(null);
  const deactivated = data.userStatus === 'deactivated';
  return (
    <DrawerLayout kicker={data.kicker} title={data.name} sub={data.title ?? undefined} tag={data.statusLabel} tagVariant={data.statusTag === 'plain' ? 'outline' : data.statusTag}>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <DrawerKpi label="Batches" value={k.batches} meta={`${k.subjects} different subject${k.subjects === 1 ? '' : 's'}`} />
        <DrawerKpi label="This week" value={k.hoursLabel} meta="from timetable" />
        <DrawerKpi label="Materials" value={k.materials} meta="uploaded" />
        <DrawerKpi label="Marks pending" value={k.marksPending} small />
      </div>

      <div className="flex gap-2 flex-wrap items-center">
        {data.canManage && (
          <Button variant="primary" disabled={deactivated || !data.isTeacher} onClick={() => setDialog('assign')} title={!data.isTeacher ? 'Add a Teacher membership first' : undefined}>
            Assign to batch
          </Button>
        )}
        {canTimetable && (
          <Button
            variant="secondary"
            onClick={() => {
              drawer.close();
              router.push(`/timetable?teacher=${data.userId}`);
            }}
          >
            Timetable
          </Button>
        )}
        {data.canManage && (
          <>
            <Button variant="secondary" onClick={() => setDialog('memberships')}>
              Edit memberships
            </Button>
            <Button variant="ghost" disabled={deactivated} onClick={() => setDialog('leave')}>
              Record leave
            </Button>
            {!data.isSelf && (
              <Button variant="ghost" onClick={() => setDialog('status')}>
                {deactivated ? 'Reactivate' : 'Deactivate'}
              </Button>
            )}
          </>
        )}
      </div>
      {data.canManage && !data.isTeacher && !deactivated && <div className="text-xs text-neutral-600 -mt-2">Assign to batch needs a Teacher membership — add one in Edit memberships.</div>}

      <Card pad="md" className="gap-2">
        <CardTitle>Memberships · role × scope</CardTitle>
        <div className="flex gap-1.5 flex-wrap" data-testid="membership-tags">
          {data.memberships.length === 0 && <span className="text-[13px] text-neutral-600">No active membership</span>}
          {data.memberships.map((m) => (
            <Tag key={m.id} variant="accent">
              {m.label}
            </Tag>
          ))}
        </div>
      </Card>

      {data.teaching.length > 0 && (
        <Card pad="none">
          <div className="px-3.5 py-2.5 border-b border-divider">
            <CardTitle>Teaching · one subject per batch</CardTitle>
          </div>
          <TableScroll>
            <Table className="text-[13px]" data-testid="teaching-table">
              <thead>
                <tr>
                  <TH className="first:pl-3.5">Batch</TH>
                  <TH>Course</TH>
                  <TH>Subject</TH>
                  <TH>Sessions</TH>
                  <TH>Room</TH>
                  <TH>Seats</TH>
                </tr>
              </thead>
              <tbody>
                {data.teaching.map((t) => (
                  <tr key={t.assignmentId}>
                    <TD className="first:pl-3.5 font-medium whitespace-nowrap">
                      {t.batchCode}
                      <div className="text-[10px] text-neutral-600 font-normal">{t.branchCode}</div>
                    </TD>
                    <TD>{t.courseName}</TD>
                    <TD>{t.subject}</TD>
                    <TD className="tabular whitespace-nowrap">{t.sessionsPerWeek} / wk</TD>
                    <TD>{t.room}</TD>
                    <TD className="tabular whitespace-nowrap">{t.seats}</TD>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        </Card>
      )}

      <div className="grid sm:grid-cols-2 gap-3 items-start">
        <Card pad="md" className="gap-0">
          <CardTitle className="mb-1.5">This week</CardTitle>
          {data.week.length === 0 && <div className="text-[13px] text-neutral-600">No sessions in the next 7 days</div>}
          {data.week.map((w, i) => (
            <div key={w.id} className={cn('flex justify-between gap-2 py-1.5 text-[13px]', i < data.week.length - 1 && 'border-b border-divider')}>
              <span>
                {w.when}
                <div className="text-[11px] text-neutral-600">
                  {w.what} · {w.where}
                </div>
              </span>
              {w.flag && <span className={cn('text-[11px] text-right', w.flag.includes('substitute') ? 'text-ink font-medium' : 'text-neutral-600')}>{w.flag}</span>}
            </div>
          ))}
        </Card>
        <div className="grid gap-3 content-start">
          <Facts
            title="Details"
            labelWidth={100}
            rows={[
              ['Email', data.facts.email],
              ['Phone', data.facts.phone],
              ['Home branch', data.facts.homeBranch],
              ['Title', data.facts.title],
              ['Employee code', data.facts.employeeCode],
              ['Joined', data.facts.joined],
            ]}
          />
          <Card pad="md" className="gap-1">
            <Kicker>Leave</Kicker>
            <div className="text-[13px]">{data.leaveSummary}</div>
          </Card>
          <Card pad="md" className="gap-0">
            <Kicker className="mb-1">Materials uploaded</Kicker>
            {data.materials.length === 0 && <div className="text-xs text-neutral-600">Nothing uploaded yet</div>}
            {data.materials.slice(0, 6).map((m, i, list) => (
              <div key={m.id} className={cn('flex justify-between gap-2 py-[5px] text-xs', i < list.length - 1 && 'border-b border-divider')}>
                <span className="min-w-0">
                  {m.batchCode} · {m.title}
                </span>
                <Tag variant={m.visTag} size="sm">
                  {m.visLabel}
                </Tag>
              </div>
            ))}
            {data.materials.length > 6 && <div className="text-[11px] text-neutral-600 pt-1">+ {data.materials.length - 6} more in Notes &amp; material</div>}
          </Card>
        </div>
      </div>

      <Card pad="md" className="gap-0" data-testid="devices-card">
        <div className="flex justify-between items-center gap-2 mb-1.5">
          <CardTitle>Active sessions &amp; devices</CardTitle>
          {data.canManage && data.devices.length > 0 && (
            <Button variant="secondary" size="sm" loading={signOut.isPending} onClick={() => signOut.mutate({ params: { id: data.userId } })}>
              Sign out everywhere
            </Button>
          )}
        </div>
        {data.devices.length === 0 && <div className="text-[13px] text-neutral-600">{deactivated ? 'Deactivated · signed out everywhere' : data.userStatus === 'invited' ? 'Invited · has not signed in yet' : 'Not signed in on any device'}</div>}
        {data.devices.map((d, i) => (
          <div key={d.id} className={cn('flex justify-between gap-2 py-1.5 text-[13px]', i < data.devices.length - 1 && 'border-b border-divider')}>
            <span>
              {d.device}
              {d.current && <Tag variant="accent" size="sm" className="ml-1.5">this device</Tag>}
              <div className="text-[11px] text-neutral-600">
                {d.method} · {d.ip ?? 'IP unknown'} · signed in {formatRelative(new Date(d.createdAt))}
              </div>
            </span>
            <span className="text-[11px] text-neutral-600 whitespace-nowrap">{d.lastSeenAt ? `active ${formatRelative(new Date(d.lastSeenAt))}` : '—'}</span>
          </div>
        ))}
      </Card>

      {data.canManage && (
        <>
          <AssignDialog person={data} open={dialog === 'assign'} onClose={close} />
          <EditMembershipsDialog person={data} open={dialog === 'memberships'} onClose={close} />
          <RecordLeaveDialog person={data} open={dialog === 'leave'} onClose={close} />
          <StatusDialog person={data} open={dialog === 'status'} onClose={close} />
        </>
      )}
    </DrawerLayout>
  );
}
