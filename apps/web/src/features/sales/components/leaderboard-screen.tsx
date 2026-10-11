'use client';

import { salesContract } from '@exatech/contracts';
import { formatINRCompact, rupeeInputToPaise } from '@exatech/domain';
import { Bar, Button, Card, Dialog, EmptyState, Input, Issue, Page, PageHeader, Skeleton, Table, TableScroll, TD, TH } from '@exatech/ui';
import { useEffect, useState } from 'react';
import type { ApiResult } from '@/lib/api';
import { useApi, useApiMutation } from '@/lib/hooks';

type Board = ApiResult<typeof salesContract.leaderboard>;

function TargetsDialog({ data, open, onOpenChange }: { data: Board; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [rows, setRows] = useState<{ userId: string; name: string; admissions: string; revenue: string }[]>([]);
  useEffect(() => {
    if (open) setRows(data.nextTargets.map((t) => ({ userId: t.userId, name: t.name, admissions: String(t.admissions), revenue: String(Math.round(t.revenue / 100)) })));
  }, [open, data.nextTargets]);
  const m = useApiMutation(salesContract.setTargets, { invalidate: [['sales']], success: `${data.nextMonthLabel} targets saved`, onSuccess: () => onOpenChange(false) });
  const bad = rows.find((r) => !/^\d+$/.test(r.admissions) || rupeeInputToPaise(r.revenue) == null);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      kicker={`Targets · ${data.scopeLabel}`}
      title={`Set ${data.nextMonthLabel} targets`}
      width={560}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={m.isPending}
            disabled={!!bad || rows.length === 0}
            onClick={() => m.mutate({ body: { month: data.nextMonth, rows: rows.map((r) => ({ userId: r.userId, admissions: Number(r.admissions), revenue: rupeeInputToPaise(r.revenue) ?? 0 })) } })}
          >
            Save targets
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[1fr_110px_150px] gap-2 items-end text-[13px]">
        <span className="text-xs text-ink/70">Salesperson</span>
        <span className="text-xs text-ink/70">Admissions</span>
        <span className="text-xs text-ink/70">Revenue (₹)</span>
        {rows.map((r, i) => (
          <div key={r.userId} className="contents">
            <span className="font-medium">{r.name}</span>
            <Input aria-label={`${r.name} admissions target`} inputMode="numeric" value={r.admissions} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, admissions: e.target.value.replace(/\D/g, '') } : y)))} />
            <Input aria-label={`${r.name} revenue target`} inputMode="numeric" value={r.revenue} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, revenue: e.target.value } : y)))} />
          </div>
        ))}
      </div>
      {bad && <Issue kind="needed">Enter whole numbers for {bad.name}</Issue>}
      <div className="text-xs text-neutral-600">Prefilled from this month. Targets drive the leaderboard bars and each salesperson’s “My month”.</div>
    </Dialog>
  );
}

/** Sales Manager · Targets & leaderboard. */
export function LeaderboardScreen() {
  const q = useApi(salesContract.leaderboard, {});
  const [open, setOpen] = useState(false);
  const d = q.data;
  return (
    <Page label="Sales Manager · Leaderboard">
      <PageHeader
        kicker={d ? `${d.monthLabel} · ${d.scopeLabel}` : ' '}
        title="Targets & leaderboard"
        actions={
          <Button variant="secondary" disabled={!d || d.rows.length === 0} onClick={() => setOpen(true)}>
            {d ? `Set ${d.nextMonthLabel} targets` : 'Set targets'}
          </Button>
        }
      />
      <Card pad="none">
        <TableScroll minWidth={760}>
          <Table>
            <thead>
              <tr>
                <TH>#</TH>
                <TH>Salesperson</TH>
                <TH>Leads</TH>
                <TH>Contacted &lt; 2 h</TH>
                <TH>Admissions</TH>
                <TH>Target</TH>
                <TH>Revenue</TH>
              </tr>
            </thead>
            <tbody>
              {!d &&
                Array.from({ length: 4 }, (_, i) => (
                  <tr key={i}>
                    <TD colSpan={7}>
                      <Skeleton className="h-6" />
                    </TD>
                  </tr>
                ))}
              {d?.rows.map((b) => (
                <tr key={b.userId}>
                  <TD className="font-semibold tabular">{b.rank}</TD>
                  <TD className="font-medium">{b.name}</TD>
                  <TD className="tabular">{b.leads}</TD>
                  <TD className="tabular">{b.fastLine}</TD>
                  <TD className="font-semibold tabular">{b.admissions}</TD>
                  <TD>
                    <div className="flex items-center gap-2">
                      <Bar value={b.targetPct} height={6} className="w-[110px]" />
                      <span className="text-xs text-neutral-600 tabular whitespace-nowrap">{b.target != null ? `${b.admissions} / ${b.target}` : 'No target'}</span>
                    </div>
                  </TD>
                  <TD className="tabular">{formatINRCompact(b.revenue)}</TD>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableScroll>
        {d && d.rows.length === 0 && <EmptyState title="No salespeople in this branch" body="Add a Salesperson membership in Staff to see them here." />}
        {q.error && <EmptyState title="Could not load the leaderboard" body={q.error.message} />}
      </Card>
      {d && <TargetsDialog data={d} open={open} onOpenChange={setOpen} />}
    </Page>
  );
}
