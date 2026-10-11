'use client';

import { institutionStaffContract } from '@exatech/contracts';
import { Button, Card, CardBody, CardMeta, CardTitle, EmptyState, Grid, LinkButton, Page, PageHeader, Skeleton, Table, TableScroll, Tag, TD, TH, TR } from '@exatech/ui';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useDrawer } from '@/components/drawers/drawer-context';
import { useApi } from '@/lib/hooks';
import { InviteDialog, LeaveCalendarDialog } from './staff-dialogs';

/** Staff & teachers: one person, many memberships (role × scope). */
export function StaffScreen() {
  const { data, isPending, error } = useApi(institutionStaffContract.list, {});
  const drawer = useDrawer();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [inviting, setInviting] = useState(false);
  const [leave, setLeave] = useState(false);
  useEffect(() => {
    if (params.get('invite') === '1') setInviting(true);
  }, [params]);
  const closeInvite = () => {
    setInviting(false);
    if (params.get('invite')) router.replace(pathname);
  };

  return (
    <Page label="Staff & teachers">
      <PageHeader
        kicker={data ? `${data.scopeLabel} · ${data.count} people · one person, many memberships` : 'Staff · one person, many memberships'}
        title="Staff & teachers"
        actions={
          <>
            <Button variant="secondary" onClick={() => setLeave(true)}>
              Leave calendar
            </Button>
            {data?.canManage && (
              <Button variant="primary" onClick={() => setInviting(true)}>
                Invite staff
              </Button>
            )}
          </>
        }
      />
      {error && <EmptyState title="Could not load staff" body={error.message} />}
      <Card pad="none">
        <TableScroll minWidth={820}>
          <Table>
            <thead>
              <tr>
                <TH>Name</TH>
                <TH>Memberships (role × scope)</TH>
                <TH>Home branch</TH>
                <TH>Teaches · batch · subject</TH>
                <TH>Load</TH>
                <TH>Status</TH>
                <TH />
              </tr>
            </thead>
            <tbody>
              {isPending &&
                Array.from({ length: 6 }, (_, i) => (
                  <tr key={i}>
                    <TD colSpan={7}>
                      <Skeleton className="h-5" />
                    </TD>
                  </tr>
                ))}
              {data?.rows.map((p) => (
                <TR key={p.userId} data-testid="staff-row">
                  <TD>
                    <LinkButton className="font-medium" onClick={() => drawer.open('teacher', p.userId)}>
                      {p.name}
                    </LinkButton>
                  </TD>
                  <TD>{p.memberships}</TD>
                  <TD>{p.homeBranch ?? '—'}</TD>
                  <TD className="text-xs max-w-[260px]">{p.teaches}</TD>
                  <TD className="text-neutral-700 whitespace-nowrap">{p.loadLabel}</TD>
                  <TD>
                    <Tag variant={p.statusTag}>{p.statusLabel}</Tag>
                  </TD>
                  <TD className="text-right whitespace-nowrap">
                    <Button variant="ghost" size="sm" onClick={() => drawer.open('teacher', p.userId)}>
                      Profile
                    </Button>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableScroll>
        {data && data.rows.length === 0 && <EmptyState title="Nobody in this branch yet" body="Invite staff and give them a membership here." />}
      </Card>

      <Grid min={280} gap={14}>
        <Card pad="lg" className="gap-2">
          <CardTitle>Leave &amp; substitutes</CardTitle>
          <div className="grid gap-0 text-[13px]">
            {isPending && <Skeleton className="h-16" />}
            {data?.notes.map((n, i) => (
              <div key={n.key} className={`flex justify-between gap-2.5 py-1.5 ${i < data.notes.length - 1 ? 'border-b border-divider' : ''}`} data-testid="leave-note">
                <button type="button" className="border-0 bg-transparent p-0 font-[inherit] text-left cursor-pointer hover:underline underline-offset-[3px]" onClick={() => drawer.open('teacher', n.userId)}>
                  {n.title}
                </button>
                <Tag variant={n.tagVariant} className="whitespace-normal text-right">
                  {n.tag}
                </Tag>
              </div>
            ))}
            {data && data.notes.length === 0 && <div className="text-neutral-600 py-1.5">No leave or cross-branch days coming up.</div>}
          </div>
        </Card>
        <Card pad="lg" className="gap-2">
          <CardTitle>How access works</CardTitle>
          <CardBody>
            A membership is role × scope. One person can be Sales Manager for a branch and Teacher for a batch at the same time, switching role from the top-right menu. New memberships start empty and inherit nothing.
          </CardBody>
          <CardMeta>Teacher load is derived from the timetable; double-booking is blocked on save.</CardMeta>
        </Card>
      </Grid>

      <InviteDialog open={inviting} onClose={closeInvite} onInvited={(id) => drawer.open('teacher', id)} />
      <LeaveCalendarDialog
        open={leave}
        onClose={() => setLeave(false)}
        onOpenPerson={(id) => {
          setLeave(false);
          drawer.open('teacher', id);
        }}
      />
    </Page>
  );
}
