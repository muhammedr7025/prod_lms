'use client';

import { academicsMarksContract } from '@exatech/contracts';
import { Bar, Button, Card, EmptyState, Issue, Kicker, Table, TableScroll, TD, TH } from '@exatech/ui';
import { useState, type ReactNode } from 'react';
import { DrawerLayout, DrawerLoading } from '@/components/drawers/drawer-host';
import { useApi } from '@/lib/hooks';
import { PublishButton, ReturnDialog } from './components/publish-actions';

function Kpi({ label, value, meta }: { label: string; value: ReactNode; meta?: ReactNode }) {
  return (
    <Card pad="sm" className="gap-0.5 px-3 py-2.5">
      <Kicker>{label}</Kicker>
      <div className="font-heading font-semibold text-[26px] leading-none tabular">{value}</div>
      {meta != null && <div className="text-[11px] text-ink/50">{meta}</div>}
    </Card>
  );
}

const fmt = (n: number | null) => (n == null ? '—' : String(Math.round(n * 10) / 10));

/** Exam panel: average / highest / lowest / missing rows, publish or return when submitted, full read-only grid. */
export default function ExamDrawer({ id }: { id: string }) {
  const { data, isPending, error } = useApi(academicsMarksContract.get, { params: { id } });
  const [returning, setReturning] = useState(false);
  if (isPending) return <DrawerLoading />;
  if (error || !data)
    return (
      <DrawerLayout kicker="Exam" title="Exam">
        <EmptyState title="Could not load this exam" body={error?.message} />
      </DrawerLayout>
    );
  return (
    <DrawerLayout kicker={`Exam · ${data.batchCode} · ${data.teacherName}`} title={data.name} sub={`${data.students} students · submitted ${data.submittedLabel}`} tag={data.statusLabel} tagVariant={data.tag === 'ink' ? 'ink' : data.tag === 'accent' ? 'accent' : data.tag === 'outline' ? 'outline' : 'neutral'}>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <Kpi label="Average" value={fmt(data.stats.average)} meta={`of ${data.maxTotal}`} />
        <Kpi label="Highest" value={fmt(data.stats.highest)} />
        <Kpi label="Lowest" value={fmt(data.stats.lowest)} />
        <Kpi label="Missing rows" value={data.stats.missing} />
      </div>
      {data.returnNote && data.status === 'returned' && <Issue kind="needed">Returned: {data.returnNote}</Issue>}
      {data.canPublish && (
        <div className="flex gap-2">
          <PublishButton exam={data} label="Publish to students & parents" />
          <Button variant="secondary" onClick={() => setReturning(true)}>
            Return to teacher
          </Button>
        </div>
      )}
      {data.status === 'draft' && <Issue kind="needed">Draft — the teacher is still entering marks; students and parents cannot see them</Issue>}
      <Card pad="none">
        <TableScroll>
          <Table className="text-[13px]">
            <thead>
              <tr>
                <TH className="first:pl-3.5">Student</TH>
                {data.components.map((c) => (
                  <TH key={c.id} className="text-center">
                    {c.name} / {c.max}
                  </TH>
                ))}
                <TH className="text-right">Total</TH>
                <TH className="w-[120px]" />
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.enrollmentId}>
                  <TD className="first:pl-3.5 font-medium">
                    {r.name}
                    <div className="text-[10px] text-neutral-600 font-mono font-normal">{r.admissionNo}</div>
                  </TD>
                  {r.values.map((v, i) => (
                    <TD key={i} className="text-center tabular">
                      {v ?? '—'}
                    </TD>
                  ))}
                  <TD className="text-right font-semibold tabular">{r.total ?? '—'}</TD>
                  <TD>
                    <Bar value={r.pct} height={5} tone={r.total != null && r.pct < 40 ? 'ink' : 'accent'} />
                  </TD>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableScroll>
        {data.rows.length === 0 && <EmptyState className="py-4" title="No students on the roster" />}
      </Card>
      <ReturnDialog exam={returning ? data : null} onClose={() => setReturning(false)} />
    </DrawerLayout>
  );
}
