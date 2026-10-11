'use client';

import { salesContract } from '@exatech/contracts';
import { formatINRCompact } from '@exatech/domain';
import { Card, CardMeta, CardTitle, cn, EmptyState, Page, PageHeader, Seg, Skeleton, Stat, Table, TD, TH } from '@exatech/ui';
import { useState } from 'react';
import { useApi } from '@/lib/hooks';

type Period = 'week' | 'month' | 'quarter';

/** Sales Manager · Funnel — KPIs, step-to-step stage funnel, lost reasons, by-source conversion. */
export function FunnelScreen() {
  const [period, setPeriod] = useState<Period>('month');
  const q = useApi(salesContract.funnel, { query: period === 'month' ? {} : { period } }, { placeholderData: (p) => p });
  const d = q.data;
  return (
    <Page label="Sales Manager · Funnel">
      <PageHeader
        kicker={d ? `${d.scopeLabel} · ${d.periodLabel}` : ' '}
        title="Funnel & conversion"
        actions={<Seg aria-label="Period" value={period} onChange={setPeriod} options={[{ value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }, { value: 'quarter', label: 'Quarter' }]} />}
      />
      {q.error && (
        <Card>
          <EmptyState title="Could not load the funnel" body={q.error.message} />
        </Card>
      )}
      <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
        {d ? (
          <>
            <Stat label="Leads" value={d.kpis.leads.toLocaleString('en-IN')} meta={d.kpis.leadsMeta} />
            <Stat label="Lead → admission" value={`${d.kpis.conversionPct}%`} meta={d.kpis.conversionMeta} />
            <Stat label="Median first response" value={d.kpis.medianFirstResponse} meta="target under 2 h" />
            <Stat label="Revenue attributed" value={formatINRCompact(d.kpis.revenue)} meta={`${d.kpis.admissions} admission${d.kpis.admissions === 1 ? '' : 's'}`} />
          </>
        ) : (
          Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[92px]" />)
        )}
      </div>
      <div className="grid gap-3.5 items-start" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))' }}>
        <Card className="gap-2.5">
          <CardTitle>Stage funnel</CardTitle>
          {!d && <Skeleton className="h-48" />}
          {d?.stages.map((f, i) => (
            <div key={f.stage} className="grid grid-cols-[minmax(110px,170px)_1fr_48px_52px] gap-2.5 items-center text-[13px]">
              <span>{f.label}</span>
              <div className="h-[18px] bg-accent-100">
                <div className={cn('h-full transition-[width] duration-300', i === d.stages.length - 1 ? 'bg-accent-700' : 'bg-accent')} style={{ width: `${f.pct}%` }} />
              </div>
              <span className="text-right tabular font-semibold">{f.n}</span>
              <span className="text-right text-neutral-600 text-xs tabular">{f.conv}</span>
            </div>
          ))}
          {d && <CardMeta>{d.lostLine}</CardMeta>}
        </Card>
        <Card className="gap-2.5">
          <CardTitle>By source</CardTitle>
          {!d && <Skeleton className="h-40" />}
          {d && (
            <Table>
              <thead>
                <tr>
                  <TH>Source</TH>
                  <TH>Leads</TH>
                  <TH>Won</TH>
                  <TH>Conv.</TH>
                </tr>
              </thead>
              <tbody>
                {d.sources.map((x) => (
                  <tr key={x.source}>
                    <TD>{x.source}</TD>
                    <TD className="tabular">{x.leads}</TD>
                    <TD className="tabular">{x.won}</TD>
                    <TD className={cn('tabular', x.best && 'text-accent-700 font-semibold')}>{x.convPct}%</TD>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {d && d.sources.length === 0 && <EmptyState title="No leads in this period" />}
        </Card>
      </div>
    </Page>
  );
}
