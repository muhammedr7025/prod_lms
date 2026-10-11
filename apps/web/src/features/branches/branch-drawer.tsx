'use client';

import { coreContract, institutionBranchesContract } from '@exatech/contracts';
import { formatINRCompact } from '@exatech/domain';
import { Button, Card, CardTitle, EmptyState, Kicker, LinkButton, Table, TableScroll, Tag, TD, TH, cn, toast } from '@exatech/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { DrawerLayout, DrawerLoading } from '@/components/drawers/drawer-host';
import { useDrawer } from '@/components/drawers/drawer-context';
import { useCan, useMe } from '@/components/me-context';
import { DrawerKpi, Facts } from '@/features/institution';
import { callApi, keyFor, type ApiError } from '@/lib/api';
import { useApi } from '@/lib/hooks';
import { BranchFormDialog, HolidaysDialog, RoomsDialog } from './components/branch-dialogs';

/** Branch panel: KPIs, Work in this branch, edit, rooms & capacity, holidays, details, batches (teacher · subject) and staff. */
export default function BranchDrawer({ id }: { id: string }) {
  const { data, isPending, error } = useApi(institutionBranchesContract.get, { params: { id } });
  const me = useMe();
  const drawer = useDrawer();
  const router = useRouter();
  const qc = useQueryClient();
  const canOps = useCan('academics:overview.read');
  const [switching, setSwitching] = useState(false);
  const [editing, setEditing] = useState(false);
  const [rooms, setRooms] = useState(false);
  const [holidays, setHolidays] = useState(false);

  if (isPending) return <DrawerLoading />;
  if (error || !data)
    return (
      <DrawerLayout kicker="Branch" title="Branch">
        <EmptyState title="Could not load this branch" body={error?.message} />
      </DrawerLayout>
    );

  const allowed = me.branch.allowed.some((b) => b.id === data.id) && !me.branch.locked;
  const workHere = async () => {
    setSwitching(true);
    try {
      const next = await callApi(coreContract.setBranch, { body: { branchId: data.id } });
      qc.setQueryData(keyFor(coreContract.me, {}), next);
      toast(`Working in ${data.name} · every list and KPI now follows this branch`);
      drawer.close();
      // Navigate first (a refresh right after push can swallow the navigation), then refetch what is cached.
      router.push(canOps ? '/branch' : '/overview');
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'api' && q.queryKey[1] !== 'me' && q.queryKey[1] !== 'reference' });
    } catch (err) {
      toast.error((err as ApiError).message);
      setSwitching(false);
    }
  };
  const k = data.kpis;
  const activeRooms = data.rooms.filter((r) => r.active);
  return (
    <DrawerLayout kicker={`Branch · ${data.code}`} title={data.name} sub={[data.address, data.city].filter(Boolean).join(', ')} tag={data.statusLabel} tagVariant={data.statusTag === 'plain' ? 'neutral' : data.statusTag}>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <DrawerKpi label="Students" value={k.students.toLocaleString('en-IN')} meta={k.studentsNote} />
        <DrawerKpi label={`Admissions · ${data.monthShort}`} value={k.admissions} meta={k.admissionsNote} />
        <DrawerKpi label="Collected" value={formatINRCompact(k.collected)} meta={`${k.collectedPct}% of target`} />
        <DrawerKpi label="Dues" value={formatINRCompact(k.dues)} meta={k.duesNote} />
      </div>
      <div className="flex gap-2 flex-wrap items-center">
        <Button variant="primary" loading={switching} disabled={!allowed || me.branch.selectedId === data.id} onClick={workHere}>
          Work in this branch
        </Button>
        {data.canManage && (
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Edit branch
          </Button>
        )}
        <Button variant="secondary" onClick={() => setRooms(true)}>
          Rooms &amp; capacity
        </Button>
        <Button variant="ghost" onClick={() => setHolidays(true)}>
          Holiday calendar
        </Button>
        {me.branch.selectedId === data.id && <span className="text-xs text-neutral-600">You are working in this branch</span>}
      </div>

      <Facts
        title="Details"
        rows={[
          ['Code', data.code],
          ['Address', [data.address, data.city].filter(Boolean).join(', ') || '—'],
          ['GSTIN', data.gstinLine],
          ['Manager', data.managerUserId ? <LinkButton onClick={() => drawer.open('teacher', data.managerUserId!)}>{data.managerName}</LinkButton> : 'Not set'],
          ['Phone', data.phone ?? '—'],
          ['Opened', data.openedLong],
          ['Status', data.statusLabel],
        ]}
      >
        <Kicker className="mt-3">Rooms · capacity</Kicker>
        <div className="flex gap-1.5 flex-wrap mt-1.5">
          {activeRooms.length === 0 && <span className="text-[13px] text-neutral-600">No rooms yet</span>}
          {activeRooms.map((r) => (
            <Tag key={r.id} variant="outline">
              {r.name} · {r.capacity}
            </Tag>
          ))}
        </div>
      </Facts>

      <Card pad="none">
        <div className="px-3.5 py-2.5 border-b border-divider">
          <CardTitle>Batches</CardTitle>
        </div>
        <TableScroll>
          <Table className="text-[13px]">
            <thead>
              <tr>
                <TH className="first:pl-3.5">Batch</TH>
                <TH>Course</TH>
                <TH>Teacher · subject</TH>
                <TH>Seats</TH>
                <TH>Status</TH>
              </tr>
            </thead>
            <tbody>
              {data.batches.map((b) => (
                <tr key={b.id}>
                  <TD className="first:pl-3.5 font-medium">{b.code}</TD>
                  <TD>{b.courseName}</TD>
                  <TD>
                    {b.teachers.length === 0 && <span className="text-neutral-600">No teacher yet</span>}
                    {b.teachers.map((t, i) => (
                      <div key={t.userId} className={cn(i > 0 && 'mt-1')}>
                        <LinkButton onClick={() => drawer.open('teacher', t.userId)}>{t.name}</LinkButton>
                        <div className="text-[11px] text-neutral-600">{t.subject}</div>
                      </div>
                    ))}
                  </TD>
                  <TD className="tabular whitespace-nowrap">
                    {b.enrolled} / {b.capacity}
                  </TD>
                  <TD>
                    <Tag variant={b.statusTag}>{b.statusLabel}</Tag>
                  </TD>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableScroll>
        {data.batches.length === 0 && <EmptyState className="py-4" title="No live batches" body="Batches are created in Courses & batches once a course is offered here." />}
      </Card>

      <Card pad="md" className="gap-0">
        <CardTitle className="mb-1.5">Staff</CardTitle>
        {data.staff.length === 0 && <div className="text-[13px] text-neutral-600">Nobody is based here yet</div>}
        {data.staff.map((p, i) => (
          <div key={p.userId} className={cn('flex justify-between gap-2 py-1.5 text-[13px]', i < data.staff.length - 1 && 'border-b border-divider')}>
            <LinkButton onClick={() => drawer.open('teacher', p.userId)}>{p.name}</LinkButton>
            <span className="text-neutral-600 text-right">{p.roles}</span>
          </div>
        ))}
      </Card>

      {data.canManage && <BranchFormDialog open={editing} onClose={() => setEditing(false)} branch={data} />}
      <RoomsDialog branchId={data.id} branchName={`${data.code} · ${data.name}`} open={rooms} onClose={() => setRooms(false)} />
      <HolidaysDialog open={holidays} onClose={() => setHolidays(false)} branchId={data.id} />
    </DrawerLayout>
  );
}
