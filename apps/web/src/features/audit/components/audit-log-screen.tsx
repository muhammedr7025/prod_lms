'use client';

import { AUDIT_ACTION_KINDS, auditContract, ROLE_META, SYSTEM_ROLES, type AuditEntry } from '@exatech/contracts';
import { formatDayMonth, toISTDate, toISTTime } from '@exatech/domain';
import { Button, Card, EmptyState, Input, Mono, Page, PageHeader, Select, Skeleton, Table, TableScroll, Tag, TD, TH, TR } from '@exatech/ui';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { callApi, keyFor, type ApiResult } from '@/lib/api';

type Range = '1h' | '24h' | '7d' | '30d' | 'all';
const RANGES: { value: Range; label: string }[] = [
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
];

/**
 * Audit log — append-only, retained 7 years, filter by actor/action/role/time,
 * keyset pagination, watermarked CSV export.
 */
export function AuditLogScreen() {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [actionKind, setActionKind] = useState('');
  const [roleKey, setRoleKey] = useState('');
  const [range, setRange] = useState<Range>('24h');

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const query = useMemo(
    () => ({
      range,
      limit: 50,
      ...(q ? { q } : {}),
      ...(actionKind ? { actionKind: actionKind as (typeof AUDIT_ACTION_KINDS)[number] } : {}),
      ...(roleKey ? { roleKey } : {}),
    }),
    [q, actionKind, roleKey, range],
  );

  // The default view's first page comes from the server prefetch (hydrated), so it renders instantly.
  const qc = useQueryClient();
  const isDefault = !q && !actionKind && !roleKey && range === '24h';
  const seed = isDefault ? qc.getQueryData<ApiResult<typeof auditContract.list>>(keyFor(auditContract.list, { query: { range: '24h', limit: 50 } })) : undefined;
  const list = useInfiniteQuery({
    initialData: seed ? { pages: [seed], pageParams: [''] } : undefined,
    queryKey: [...keyFor(auditContract.list, { query }), 'infinite'],
    queryFn: ({ pageParam }) => callApi(auditContract.list, { query: { ...query, ...(pageParam ? { cursor: pageParam } : {}) } }),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: (prev) => prev,
  });
  const rows: AuditEntry[] = list.data?.pages.flatMap((p) => p.items) ?? [];
  const exportHref = `${auditContract.exportPath}?${new URLSearchParams(Object.entries(query).filter(([k]) => k !== 'limit').map(([k, v]) => [k, String(v)])).toString()}`;

  return (
    <Page label="Audit log">
      <PageHeader
        kicker="Append-only · retained 7 years"
        title="Audit log"
        actions={
          <a href={exportHref} download>
            <Button variant="secondary">Export CSV (watermarked)</Button>
          </a>
        }
      />
      <div className="flex gap-2 flex-wrap">
        <Input placeholder="Filter by actor, entity or ID" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-[280px]" aria-label="Filter" />
        <Select className="w-auto" value={actionKind} onChange={(e) => setActionKind(e.target.value)} aria-label="Action" options={[{ value: '', label: 'All actions' }, ...AUDIT_ACTION_KINDS.map((k) => ({ value: k, label: k[0]!.toUpperCase() + k.slice(1) }))]} />
        <Select className="w-auto" value={roleKey} onChange={(e) => setRoleKey(e.target.value)} aria-label="Role" options={[{ value: '', label: 'All roles' }, ...SYSTEM_ROLES.map((r) => ({ value: r, label: ROLE_META[r].label }))]} />
        <Select className="w-auto" value={range} onChange={(e) => setRange(e.target.value as Range)} aria-label="Time" options={RANGES} />
      </div>
      <Card pad="none">
        <TableScroll minWidth={860}>
          <Table>
            <thead>
              <tr>
                <TH>Time (IST)</TH>
                <TH>Actor</TH>
                <TH>Active role</TH>
                <TH>Action</TH>
                <TH>Entity</TH>
                <TH>Before → after</TH>
                <TH>IP</TH>
              </tr>
            </thead>
            <tbody>
              {list.isPending &&
                Array.from({ length: 6 }, (_, i) => (
                  <tr key={i}>
                    <TD colSpan={7}>
                      <Skeleton className="h-5" />
                    </TD>
                  </tr>
                ))}
              {rows.map((a) => {
                const at = new Date(a.at);
                const today = toISTDate(at) === toISTDate(new Date());
                return (
                  <TR key={a.id}>
                    <TD className="tabular text-neutral-600 whitespace-nowrap">{today ? toISTTime(at) : `${formatDayMonth(toISTDate(at))} ${toISTTime(at)}`}</TD>
                    <TD className="font-medium">{a.actorName}</TD>
                    <TD>{a.roleLabel && <Tag variant="neutral">{a.roleLabel}</Tag>}</TD>
                    <TD>{a.action}</TD>
                    <TD>
                      <Mono>{a.entity}</Mono>
                    </TD>
                    <TD className="text-xs text-neutral-700">{a.summary}</TD>
                    <TD className="text-xs text-neutral-500">{a.ip}</TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        </TableScroll>
        {!list.isPending && rows.length === 0 && <EmptyState title="Nothing in this window" body="Every write in the product appends a row here. Widen the time range or clear filters." />}
        {list.error && <EmptyState title="Could not load the audit log" body={list.error.message} />}
        {list.hasNextPage && (
          <div className="px-4 py-2.5 border-t border-divider">
            <Button variant="secondary" loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
              Load more
            </Button>
          </div>
        )}
      </Card>
    </Page>
  );
}
