'use client';

import { financeContract } from '@exatech/contracts';
import { formatINR } from '@exatech/domain';
import { Card, EmptyState, Input, Page, PageHeader, Seg, Skeleton, Sub, Table, TableScroll, Tag, TD, TH, TR } from '@exatech/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useApi } from '@/lib/hooks';

type Filter = 'all' | 'overdue' | 'locked' | 'no_schedule';

/** Student fee accounts — search, then open the full account. */
export function AccountsScreen() {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [qs, setQs] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  useEffect(() => {
    const t = setTimeout(() => setQs(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const q = useApi(financeContract.accounts, { query: { ...(qs ? { q: qs } : {}), filter, limit: 50 } }, { placeholderData: (p) => p });
  const items = q.data?.items ?? [];
  return (
    <Page label="Finance · Student fee accounts">
      <PageHeader
        kicker={q.data ? `${q.data.total} account${q.data.total === 1 ? '' : 's'} in scope · overdue first` : 'Fee accounts'}
        title="Student fee accounts"
        actions={
          <Seg
            aria-label="Filter"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'overdue', label: 'Overdue' },
              { value: 'locked', label: 'Notes locked' },
              { value: 'no_schedule', label: 'No schedule' },
            ]}
          />
        }
      />
      <Input placeholder="Name, admission no. or phone" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-[320px]" aria-label="Search accounts" autoFocus />
      <Card pad="none">
        <TableScroll minWidth={820}>
          <Table>
            <thead>
              <tr>
                <TH>Student</TH>
                <TH>Batch</TH>
                <TH className="text-right">Total fee</TH>
                <TH className="text-right">Paid</TH>
                <TH className="text-right">Outstanding</TH>
                <TH className="text-right">Overdue</TH>
                <TH>Clearance</TH>
              </tr>
            </thead>
            <tbody>
              {q.isPending &&
                Array.from({ length: 6 }, (_, i) => (
                  <tr key={i}>
                    <TD colSpan={7}>
                      <Skeleton className="h-6" />
                    </TD>
                  </tr>
                ))}
              {items.map((r) => (
                <TR key={r.enrollmentId} onClick={() => router.push(`/finance/accounts/${r.enrollmentId}`)}>
                  <TD className="font-medium">
                    {r.studentName}
                    <Sub>{r.admissionNo ?? '—'}</Sub>
                  </TD>
                  <TD>
                    {r.batchCode}
                    <Sub>{r.branchName}</Sub>
                  </TD>
                  <TD className="text-right tabular">{r.hasSchedule ? formatINR(r.feeTotal) : <Tag variant="outline">No fee schedule yet</Tag>}</TD>
                  <TD className="text-right tabular">{formatINR(r.paid)}</TD>
                  <TD className="text-right tabular">{formatINR(r.outstanding)}</TD>
                  <TD className="text-right tabular font-semibold">{r.overdue ? formatINR(r.overdue) : '—'}</TD>
                  <TD>
                    <Tag variant={r.feeCleared ? 'accent' : 'ink'}>{r.feeCleared ? 'Unlocked' : 'Locked'}</Tag>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableScroll>
        {q.data && q.data.total > items.length && <div className="px-4 py-2 text-xs text-neutral-600 border-t border-divider">Showing {items.length} of {q.data.total} · search by name, admission no. or phone to find anyone else</div>}
        {q.data && items.length === 0 && <EmptyState title="No fee accounts match" body="Try a name, an admission number like TVM-DM-2027-00142, or the last digits of a phone number." />}
        {q.error && <EmptyState title="Could not load fee accounts" body={q.error.message} />}
      </Card>
    </Page>
  );
}
