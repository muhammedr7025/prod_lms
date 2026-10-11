'use client';

import { PORTAL_PATHS, portalContract } from '@exatech/contracts';
import { Button, buttonVariants, Card, cn, Icon, Kicker, Skeleton, Tag } from '@exatech/ui';
import { useState } from 'react';
import { useApi } from '@/lib/hooks';
import { LoadError, ScreenHeader } from './parts';

/** Student · Timetable — week list (classes, exams, holidays), prev/next week, ICS export. */
export function TimetableScreen() {
  const [week, setWeek] = useState<string | undefined>(undefined);
  const { data, error, isPending, refetch } = useApi(portalContract.timetable, { query: week ? { week } : {} }, { placeholderData: (prev) => prev });

  return (
    <>
      <ScreenHeader
        label="Student · Timetable"
        kicker={data?.kicker}
        title="Timetable"
        action={
          <a href={PORTAL_PATHS.timetableIcs} download className={cn(buttonVariants({ variant: 'secondary', size: 'lg' }), 'no-underline')} data-testid="export-ics">
            Export ICS
          </a>
        }
      />
      <div className="flex gap-1.5">
        <Button size="lg" className="flex-1" onClick={() => data && setWeek(data.prev)} disabled={!data} aria-label="Previous week">
          <Icon name="chevronLeft" /> Previous
        </Button>
        <Button size="lg" className="flex-1" onClick={() => setWeek(undefined)} disabled={!data || data.isCurrent}>
          This week
        </Button>
        <Button size="lg" className="flex-1" onClick={() => data && setWeek(data.next)} disabled={!data} aria-label="Next week">
          Next <Icon name="chevronRight" />
        </Button>
      </div>
      {error && !data && <LoadError what="the timetable" error={error} onRetry={() => void refetch()} />}
      {isPending && !data && Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[74px]" />)}
      {data?.days.map((d) => (
        <Card key={d.date} className={cn('px-3.5 py-3 gap-1', d.past && 'opacity-60', d.today && 'border-accent')} data-testid="tt-day">
          <div className="flex justify-between items-center gap-2">
            <Kicker>
              {d.label}
              {d.today ? ' · today' : ''}
            </Kicker>
            {d.items.length === 0 && <span className="text-[11px] text-neutral-500">No class</span>}
          </div>
          {d.items.map((x, i) => (
            <div key={x.id} className={cn('flex justify-between items-start gap-2', i > 0 && 'border-t border-divider pt-1.5 mt-0.5')}>
              <div className="min-w-0">
                <div className="text-sm font-medium">{x.title}</div>
                <div className="text-xs text-neutral-600">{x.sub}</div>
              </div>
              <Tag variant={x.tagVariant} className="flex-none">
                {x.tag}
              </Tag>
            </div>
          ))}
        </Card>
      ))}
      {data && <div className="text-xs text-neutral-600 text-center">Export ICS adds the next 8 weeks (classes, exams, holidays) to your phone calendar.</div>}
    </>
  );
}
