'use client';

import { institutionBranchesContract } from '@exatech/contracts';
import { Button, Card, CardBody, CardButton, CardMeta, CardTitle, EmptyState, Grid, Kicker, Page, PageHeader, Skeleton, Tag } from '@exatech/ui';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useDrawer } from '@/components/drawers/drawer-context';
import { useApi } from '@/lib/hooks';
import { BranchFormDialog, HolidaysDialog } from './branch-dialogs';

/** Super Admin · Branches: branch cards (→ branch panel), holiday calendar, add branch. */
export function BranchesScreen() {
  const { data, isPending, error } = useApi(institutionBranchesContract.list, {});
  const drawer = useDrawer();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [adding, setAdding] = useState(false);
  const [holidays, setHolidays] = useState(false);
  useEffect(() => {
    if (params.get('new') === '1') setAdding(true);
    if (params.get('holidays') === '1') setHolidays(true);
  }, [params]);
  const clearParams = () => {
    if (params.get('new') || params.get('holidays')) router.replace(pathname);
  };
  const upcoming = data?.upcoming ?? [];
  const shown = upcoming.slice(0, 4);
  const more = upcoming.length - shown.length;

  return (
    <Page label="Super Admin · Branches">
      <PageHeader
        kicker="Institution"
        title="Branches"
        actions={
          data?.canManage && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              Add branch
            </Button>
          )
        }
      />
      {error && <EmptyState title="Could not load branches" body={error.message} />}
      <Grid min={280} gap={14} className="items-stretch">
        {isPending &&
          Array.from({ length: 3 }, (_, i) => (
            <Card key={i} pad="lg" className="gap-2">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-10" />
              <Skeleton className="h-8" />
            </Card>
          ))}
        {data?.branches.map((b) => (
          <CardButton key={b.id} pad="lg" className="gap-2 bg-white" onClick={() => drawer.open('branch', b.id)} data-testid="branch-card" aria-label={`${b.name} branch details`}>
            <div className="flex justify-between gap-2 items-start">
              <Kicker>
                {b.code} · opened {b.openedLabel}
              </Kicker>
              <Tag variant={b.statusTag}>{b.statusLabel}</Tag>
            </div>
            <CardTitle>{b.name}</CardTitle>
            <CardBody>
              {b.address ?? b.city ?? 'No address'} · GSTIN {b.gstinLine}
            </CardBody>
            <div className="grid grid-cols-3 gap-2 text-xs text-neutral-700 border-t border-divider pt-2">
              <div>
                <b className="font-semibold text-ink">{b.roomCount}</b> room{b.roomCount === 1 ? '' : 's'}
              </div>
              <div>
                <b className="font-semibold text-ink">{b.batchCount}</b> batch{b.batchCount === 1 ? '' : 'es'}
              </div>
              <div>
                <b className="font-semibold text-ink">{b.studentCount.toLocaleString('en-IN')}</b> student{b.studentCount === 1 ? '' : 's'}
              </div>
            </div>
            <CardMeta>Manager · {b.managerName ?? 'not set'} · open for details →</CardMeta>
          </CardButton>
        ))}
      </Grid>
      {data && data.branches.length === 0 && <EmptyState title="No branches yet" body="Add the first branch to start offering courses." />}

      <Card pad="lg" className="gap-2.5" data-testid="holiday-card">
        <CardTitle>Holiday calendar · {data?.academicYearLabel ?? ''}</CardTitle>
        <CardBody>Holidays suppress sessions and pause fee reminders automatically.</CardBody>
        <div className="flex gap-2 flex-wrap">
          {isPending && <Skeleton className="h-6 w-80" />}
          {shown.map((h) => (
            <Tag key={h.id} variant="outline">
              {h.shortLabel} · {h.name}
              {h.branchId ? ` (${h.scopeLabel})` : ''}
            </Tag>
          ))}
          {data && (
            <button type="button" onClick={() => setHolidays(true)} className="cursor-pointer border-0 p-0 bg-transparent">
              <Tag variant="neutral" className="hover:bg-neutral-200">
                {more > 0 ? `+ ${more} more` : upcoming.length === 0 ? 'No upcoming holidays · open calendar' : 'Full calendar'}
              </Tag>
            </button>
          )}
        </div>
      </Card>

      <BranchFormDialog
        open={adding}
        onClose={() => {
          setAdding(false);
          clearParams();
        }}
        onCreated={(b) => drawer.open('branch', b.id)}
      />
      <HolidaysDialog
        open={holidays}
        onClose={() => {
          setHolidays(false);
          clearParams();
        }}
      />
    </Page>
  );
}
