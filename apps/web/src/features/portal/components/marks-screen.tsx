'use client';

import { portalContract } from '@exatech/contracts';
import { Bar, buttonVariants, Card, CardMeta, CardTitle, cn, Icon, Kicker, Skeleton } from '@exatech/ui';
import { useApi } from '@/lib/hooks';
import { LoadError, ScreenHeader } from './parts';

const SHADES = ['bg-accent-300', 'bg-accent-400', 'bg-accent-500', 'bg-accent'];

/** Student / Parent · Marks — published exams only, batch average + grade, trend, report card. */
export function MarksScreen({ studentId, label }: { studentId?: string; label: string }) {
  const enabled = label.startsWith('Student') || !!studentId;
  const { data, error, isPending, refetch } = useApi(portalContract.marks, { query: studentId ? { studentId } : {} }, { enabled });
  return (
    <>
      <ScreenHeader label={label} kicker={data?.kicker} title="Marks" />
      {error && !data && <LoadError what="marks" error={error} onRetry={() => void refetch()} />}
      {(isPending || !enabled) && !data && Array.from({ length: 2 }, (_, i) => <Skeleton key={i} className="h-[112px]" />)}
      {data && data.items.length === 0 && (
        <Card pad="none">
          <div className="px-4 py-6 text-center text-[13px] text-neutral-600">No published marks yet. Marks appear here once the Branch Administrator publishes them — drafts are never shown.</div>
        </Card>
      )}
      {data?.items.map((m) => (
        <Card key={m.examId} className="p-3.5 gap-2" data-testid="mark-card">
          <div className="flex justify-between items-baseline gap-2">
            <div className="min-w-0">
              <Kicker>{m.when}</Kicker>
              <CardTitle>{m.name}</CardTitle>
            </div>
            <div className="font-heading font-semibold text-[28px] leading-none tabular flex-none">
              {m.score}
              <span className="text-sm text-neutral-600"> / {m.max}</span>
            </div>
          </div>
          <Bar value={m.pct} height={6} />
          <CardMeta>{m.meta}</CardMeta>
          {m.components.length > 1 && <div className="text-xs text-neutral-600">{m.components.map((c) => `${c.name} ${c.score ?? '—'} / ${c.max}`).join(' · ')}</div>}
        </Card>
      ))}
      {data && (
        <Card tone="line" className="p-3.5 gap-1.5" data-testid="trend-card">
          <Kicker>Trend</Kicker>
          {data.trend.length > 0 ? (
            <TrendBars trend={data.trend} nextExam={data.nextExam} />
          ) : (
            <div className="text-[13px] text-neutral-600">Your trend builds up as exams are published.</div>
          )}
          <CardMeta>{data.note}</CardMeta>
          {data.reportCardUrl && (
            <a href={data.reportCardUrl} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: 'secondary', size: 'lg' }), 'no-underline mt-1')} data-testid="report-card">
              <Icon name="download" /> Report card (PDF)
            </a>
          )}
        </Card>
      )}
    </>
  );
}

/** Last published % bars (oldest → newest) + a dashed slot for the next exam; at least 4 slots so bars keep their width. */
function TrendBars({ trend, nextExam }: { trend: { label: string; pct: number }[]; nextExam: string | null }) {
  const slots = Math.max(4, trend.length + (nextExam ? 1 : 0));
  const empty = slots - trend.length - (nextExam ? 1 : 0);
  return (
    <>
      <div className="flex items-end gap-1.5 h-[60px]" role="img" aria-label={`Trend: ${trend.map((t) => `${t.label} ${t.pct}%`).join(', ')}`}>
        {trend.map((t, i) => (
          <div key={`${t.label}-${i}`} className={cn('flex-1', SHADES[Math.max(0, SHADES.length - trend.length + i)] ?? 'bg-accent')} style={{ height: `${Math.max(4, t.pct)}%` }} title={`${t.label} · ${t.pct}%`} />
        ))}
        {nextExam && <div className="flex-1 h-0 border-t border-dashed border-ink/40" title={nextExam} />}
        {Array.from({ length: empty }, (_, i) => (
          <div key={`e${i}`} className="flex-1 h-0" />
        ))}
      </div>
      <div className="flex gap-1.5 text-[10px] text-neutral-600 leading-tight">
        {trend.map((t, i) => (
          <span key={`${t.label}-${i}`} className="flex-1 min-w-0 text-center">
            {t.label}
            <span className="block tabular">{t.pct}%</span>
          </span>
        ))}
        {nextExam && (
          <span className="flex-1 min-w-0 text-center">
            {nextExam.split(' · ')[0]}
            <span className="block">{nextExam.split(' · ')[1] ?? 'next'}</span>
          </span>
        )}
        {Array.from({ length: empty }, (_, i) => (
          <span key={`e${i}`} className="flex-1" />
        ))}
      </div>
    </>
  );
}
