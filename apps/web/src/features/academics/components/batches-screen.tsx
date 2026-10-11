'use client';

import { academicsBatchesContract, type AcadBatchRow } from '@exatech/contracts';
import { Bar, Button, Card, CardHead, CardMeta, CardTitle, EmptyState, Grid, Kicker, LinkButton, Page, PageHeader, Seg, Skeleton, Sub, Table, TableScroll, Tag, TD, TH, TR, cn } from '@exatech/ui';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useDrawer } from '@/components/drawers/drawer-context';
import { useApi } from '@/lib/hooks';
import { AssignTeacherDialog, EditBatchDialog, NewBatchDialog, OfferCourseDialog } from './batch-dialogs';

type Filter = 'all' | 'running' | 'open' | 'planned';

/** Branch Administrator · Courses & batches. */
export function BatchesScreen() {
  const { data, isPending, error } = useApi(academicsBatchesContract.list, {});
  const drawer = useDrawer();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [filter, setFilter] = useState<Filter>('all');
  const [newOpen, setNewOpen] = useState(false);
  const [offerOpen, setOfferOpen] = useState(false);
  const [editing, setEditing] = useState<AcadBatchRow | null>(null);
  const [assigning, setAssigning] = useState<AcadBatchRow | null>(null);
  const highlight = params.get('batch');

  useEffect(() => {
    if (params.get('new') === '1') setNewOpen(true);
  }, [params]);
  useEffect(() => {
    if (!highlight || !data) return;
    document.getElementById(`batch-${highlight}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlight, data]);

  const rows = useMemo(() => (data?.batches ?? []).filter((b) => filter === 'all' || b.status === filter), [data, filter]);
  const canManage = data?.canManage ?? false;
  const closeNew = () => {
    setNewOpen(false);
    if (params.get('new')) router.replace(pathname);
  };

  return (
    <Page label="Branch Admin · Courses & batches">
      <PageHeader
        kicker="Institution → Branch → Offering → Batch"
        title="Courses & batches"
        actions={
          canManage && (
            <>
              <Button variant="secondary" onClick={() => setOfferOpen(true)}>
                Offer a course here
              </Button>
              <Button variant="primary" onClick={() => setNewOpen(true)}>
                New batch
              </Button>
            </>
          )
        }
      />
      {error && <EmptyState title="Could not load courses & batches" body={error.message} />}
      <Grid min={200} className="items-stretch">
        {isPending && Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[84px]" />)}
        {data?.offerings.map((o) => (
          <Card key={o.id} pad="md" className="gap-1">
            <Kicker>{o.kicker}</Kicker>
            <CardTitle>{o.courseName}</CardTitle>
            <CardMeta>{o.meta}</CardMeta>
          </Card>
        ))}
        {data && data.offerings.length === 0 && (
          <Card tone="dashed" pad="md">
            <CardTitle>No courses offered here yet</CardTitle>
            <CardMeta>Use “Offer a course here” to add one with its default fee plan.</CardMeta>
          </Card>
        )}
      </Grid>

      <Card pad="none">
        <CardHead>
          <CardTitle>Batches · {data?.branchLabel ?? '…'}</CardTitle>
          <Seg
            aria-label="Batch status"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'running', label: 'Running' },
              { value: 'open', label: 'Open' },
              { value: 'planned', label: 'Planned' },
            ]}
          />
        </CardHead>
        <TableScroll minWidth={860}>
          <Table>
            <thead>
              <tr>
                <TH>Batch</TH>
                <TH>Course</TH>
                <TH>Schedule</TH>
                <TH>Teacher · subject</TH>
                <TH>Room</TH>
                <TH>Seats</TH>
                <TH>Fee plan</TH>
                <TH>Status</TH>
              </tr>
            </thead>
            <tbody>
              {isPending &&
                Array.from({ length: 6 }, (_, i) => (
                  <tr key={i}>
                    <TD colSpan={8}>
                      <Skeleton className="h-6" />
                    </TD>
                  </tr>
                ))}
              {rows.map((b) => (
                <TR
                  key={b.id}
                  id={`batch-${b.code}`}
                  className={cn(highlight === b.code && 'bg-accent-100 outline outline-1 outline-accent')}
                  onClick={canManage ? () => setEditing(b) : undefined}
                  title={canManage ? 'Edit batch' : undefined}
                >
                  <TD className="font-medium">
                    {b.code}
                    {data && new Set(data.batches.map((x) => x.branchCode)).size > 1 && <Sub>{b.branchCode}</Sub>}
                  </TD>
                  <TD>{b.courseName}</TD>
                  <TD className="text-neutral-700">{b.schedule}</TD>
                  <TD onClick={(e) => e.stopPropagation()}>
                    {b.teacherUserId ? (
                      <>
                        <LinkButton onClick={() => drawer.open('teacher', b.teacherUserId!)}>{b.teacherName}</LinkButton>
                        <Sub>
                          {b.subjectName}
                          {b.assignments.length > 1 ? ` · +${b.assignments.length - 1} more` : ''}
                        </Sub>
                      </>
                    ) : canManage ? (
                      <Button variant="ghost" size="sm" onClick={() => setAssigning(b)}>
                        Assign teacher
                      </Button>
                    ) : (
                      <span className="text-neutral-600">—</span>
                    )}
                  </TD>
                  <TD>{b.roomName ?? (b.mode === 'online' ? 'Online' : '—')}</TD>
                  <TD>
                    <div className="flex items-center gap-2">
                      <Bar value={b.seatsPct} className="w-[70px]" height={5} />
                      <span className="tabular">
                        {b.enrolled} / {b.capacity}
                      </span>
                    </div>
                  </TD>
                  <TD className="text-xs">{b.feePlanName ?? '—'}</TD>
                  <TD>
                    <Tag variant={b.tag}>{b.statusLabel}</Tag>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableScroll>
        {data && rows.length === 0 && <EmptyState title={filter === 'all' ? 'No batches yet' : `No ${filter} batches`} body={canManage ? 'Create one with “New batch” — sessions are generated from its weekly schedule.' : undefined} />}
      </Card>

      {data && (
        <>
          <NewBatchDialog open={newOpen} onClose={closeNew} offerings={data.offerings} batches={data.batches} />
          <OfferCourseDialog open={offerOpen} onClose={() => setOfferOpen(false)} offerings={data.offerings} />
          <EditBatchDialog batch={editing} onClose={() => setEditing(null)} onAssign={(b) => setAssigning(b)} />
          <AssignTeacherDialog batch={assigning} onClose={() => setAssigning(null)} />
        </>
      )}
    </Page>
  );
}
