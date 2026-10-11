'use client';

import { admissionsContract } from '@exatech/contracts';
import { buttonVariants, Card, CardTitle, cn, EmptyState, Skeleton, Tag } from '@exatech/ui';
import Link from 'next/link';
import { useCan } from '@/components/me-context';
import { useApi } from '@/lib/hooks';
import { StepBar } from './step-bar';

/** "My applications" — the salesperson's drafts, submissions and returned applications (Resubmit). */
export function MyApplications() {
  const canUpdate = useCan('admissions:update');
  const q = useApi(admissionsContract.list, { query: { status: 'mine' } });
  const items = q.data?.items ?? [];
  return (
    <Card pad="none" aria-label="My applications">
      <div className="flex justify-between items-center px-4 py-3 border-b border-divider">
        <CardTitle>My applications</CardTitle>
        <Tag variant="neutral">{q.data?.counts.mine ?? '…'}</Tag>
      </div>
      {q.isPending && (
        <div className="p-4 grid gap-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      )}
      {items.map((a) => {
        const back = a.status === 'returned' && a.returnedTo === 'sales';
        return (
          <div key={a.id} className="px-4 py-3 border-b border-divider grid gap-1.5 text-[13px] last:border-b-0" data-testid="my-application">
            <div className="flex justify-between gap-2 flex-wrap items-center">
              <div className="min-w-0">
                <b className="font-medium">{a.studentName}</b>
                <span className="text-neutral-600">
                  {' '}
                  · {a.batchCode} · {a.planLine}
                  {a.discountPct ? ` · ${a.discountPct}%` : ''}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <StepBar row={a} />
                {a.admissionNo ? <Tag variant="accent">Approved · {a.admissionNo}</Tag> : <Tag variant={back ? 'ink' : a.status === 'draft' ? 'plain' : 'neutral'}>{a.stepLabel}</Tag>}
                {canUpdate && (back || a.status === 'draft') && (
                  <Link href={`/sales/admission?id=${a.id}`} className={cn(buttonVariants({ variant: back ? 'primary' : 'secondary', size: 'sm' }))}>
                    {back ? 'Resubmit' : 'Continue'}
                  </Link>
                )}
              </div>
            </div>
            {a.returnNote && <div className="text-xs text-ink">Returned: {a.returnNote}</div>}
          </div>
        );
      })}
      {!q.isPending && items.length === 0 && <EmptyState title="No applications yet" body="Convert a lead to start one — drafts save automatically." />}
      {q.error && <EmptyState title="Could not load your applications" body={q.error.message} />}
    </Card>
  );
}
