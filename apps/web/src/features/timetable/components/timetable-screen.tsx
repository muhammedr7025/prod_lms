'use client';

import { academicsTimetableContract, type AcadSessionChip, type AcadTimetableWeek } from '@exatech/contracts';
import { addDays } from '@exatech/domain';
import { Button, Card, EmptyState, Icon, Kicker, Page, PageHeader, Seg, Select, Skeleton, Tag, cn, toast } from '@exatech/ui';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi, useApiMutation } from '@/lib/hooks';
import { SessionDialog, type SessionDialogState } from './session-dialog';

type View = 'room' | 'teacher' | 'batch';

const CHIP_STYLE: Record<AcadSessionChip['style'], string> = {
  normal: 'bg-accent-100 border-accent-300 text-ink',
  leave: 'bg-white border-ink border-dashed text-ink',
  substitute: 'bg-white border-accent text-ink',
  planned: 'bg-white border-dashed border-neutral-400 text-neutral-700',
  suppressed: 'bg-neutral-100 border-neutral-200 text-neutral-500 line-through',
  exam: 'bg-ink border-ink text-white',
  adhoc: 'bg-accent-200 border-accent border-dashed text-ink',
};
const STYLE_NOTE: Record<AcadSessionChip['style'], string> = {
  normal: '',
  leave: ' · teacher on leave, needs a substitute',
  substitute: ' · substitute teacher',
  planned: ' · planned batch',
  suppressed: ' · holiday, suppressed',
  exam: ' · exam',
  adhoc: ' · ad-hoc session',
};

/** Branch Administrator · Timetable — week grid, live conflicts, validated-on-save checks and substitutes. */
export function TimetableScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [week, setWeek] = useState<string | undefined>(undefined);
  const [view, setView] = useState<View>('room');
  const [filter, setFilter] = useState('');
  const [dialog, setDialog] = useState<SessionDialogState | null>(null);
  const { data, isPending, error, isFetching } = useApi(academicsTimetableContract.week, { query: week ? { week } : {} }, { placeholderData: (prev) => prev });
  const fix = useApiMutation(academicsTimetableContract.moveRoom, { invalidate: [['academics']], success: 'Conflict fixed · the batch was notified' });
  const sub = useApiMutation(academicsTimetableContract.substitute, { invalidate: [['academics']], success: 'Substitute assigned · students and both teachers notified' });

  useEffect(() => {
    if (params.get('add') === '1' && data) setDialog({ mode: 'add', batchId: undefined });
  }, [params, data]);
  const appliedBatch = useRef<string | null>(null);
  useEffect(() => {
    const b = params.get('batch');
    if (b && data && appliedBatch.current !== b) {
      appliedBatch.current = b;
      const match = data.batches.find((x) => x.id === b || x.code === b);
      if (match) {
        setView('batch');
        setFilter(match.id);
      }
    }
  }, [params, data]);

  const filterOptions = useMemo(() => {
    if (!data) return [];
    if (view === 'room') return [{ value: '', label: 'All rooms' }, ...data.rooms.map((r) => ({ value: r.id, label: r.name }))];
    if (view === 'teacher') {
      const ids = new Set(data.sessions.map((s) => s.teacherUserId));
      return [{ value: '', label: 'All teachers' }, ...data.teachers.filter((t) => ids.has(t.id)).map((t) => ({ value: t.id, label: t.name }))];
    }
    return [{ value: '', label: 'All batches' }, ...data.batches.map((b) => ({ value: b.id, label: b.code }))];
  }, [data, view]);

  const visible = (s: AcadSessionChip) => !filter || (view === 'room' ? s.roomId === filter : view === 'teacher' ? s.teacherUserId === filter : s.batchId === filter);
  const closeDialog = () => {
    setDialog(null);
    if (params.get('add')) router.replace(pathname);
  };

  return (
    <Page label="Branch Admin · Timetable">
      <PageHeader
        kicker={data ? `Week ${data.weekNumber} · ${data.rangeLabel} · ${data.branchLabel}` : <Skeleton className="h-3 w-48" />}
        title="Timetable"
        actions={
          <>
            <div className="flex">
              <Button variant="secondary" size="iconSm" aria-label="Previous week" onClick={() => data && setWeek(addDays(data.monday, -7))}>
                <Icon name="chevronLeft" size={14} />
              </Button>
              <Button variant="secondary" className="-ml-px h-[34px]" disabled={data?.isThisWeek} onClick={() => setWeek(undefined)}>
                This week
              </Button>
              <Button variant="secondary" size="iconSm" className="-ml-px" aria-label="Next week" onClick={() => data && setWeek(addDays(data.monday, 7))}>
                <Icon name="chevronRight" size={14} />
              </Button>
            </div>
            <Seg
              aria-label="View"
              value={view}
              onChange={(v) => {
                setView(v);
                setFilter('');
              }}
              options={[
                { value: 'room', label: 'By room' },
                { value: 'teacher', label: 'By teacher' },
                { value: 'batch', label: 'By batch' },
              ]}
            />
            <Select aria-label={`Filter by ${view}`} className="w-auto min-w-[140px]" value={filter} onChange={(e) => setFilter(e.target.value)} options={filterOptions} />
            {data?.canManage && (
              <Button variant="primary" onClick={() => setDialog({ mode: 'add' })}>
                Add session
              </Button>
            )}
          </>
        }
      />
      {error && <EmptyState title="Could not load the timetable" body={error.message} />}
      <div className="grid gap-3.5 items-start min-[1500px]:grid-cols-[minmax(0,1fr)_340px]">
        <Card pad="none" className={cn('min-w-0', isFetching && !isPending && 'opacity-80')}>
          {!data ? <Skeleton className="h-[420px] m-4" /> : <WeekGrid data={data} visible={visible} onEdit={(c) => (c.editable ? setDialog({ mode: 'edit', chip: c }) : toast(c.lockedReason ?? 'This session cannot be changed'))} onAdd={(date, start) => data.canManage && setDialog({ mode: 'add', date, start })} />}
        </Card>
        <div className="grid gap-3.5 items-start md:grid-cols-3 min-[1500px]:grid-cols-1">
          <Card tone="ink" pad="md" className="gap-2" data-testid="conflicts-card">
            <div className="flex justify-between items-center">
              <Kicker className="text-ink">Conflicts · live</Kicker>
              <Tag variant="ink">{data?.conflicts.length ?? '…'}</Tag>
            </div>
            {data?.conflicts.map((c) => (
              <div key={c.key} className="grid gap-1.5 py-1.5 border-b border-divider last:border-b-0 text-[13px]">
                <div>{c.message}</div>
                {c.fix && (
                  <div>
                    <Button variant="secondary" size="sm" loading={fix.isPending && fix.variables?.params.id === c.fix.sessionId} onClick={() => c.fix && fix.mutate({ params: { id: c.fix.sessionId }, body: { roomId: c.fix.roomId } })}>
                      {c.fix.label}
                    </Button>
                  </div>
                )}
              </div>
            ))}
            {data && data.conflicts.length === 0 && <div className="text-[13px] opacity-80">No room or teacher clashes this week. Saves are blocked when one appears.</div>}
          </Card>
          <Card pad="md" className="gap-2">
            <Kicker>Validated on save</Kicker>
            <div className="text-[13px] grid gap-1.5">
              {!data && <Skeleton className="h-16" />}
              {data?.checks.map((c) => (
                <div key={c.text} className="flex gap-2 items-start">
                  <Tag variant={c.ok ? 'accent' : 'ink'}>{c.ok ? 'OK' : 'Check'}</Tag>
                  <span>{c.text}</span>
                </div>
              ))}
            </div>
          </Card>
          <Card pad="md" className="gap-2" data-testid="substitute-card">
            <Kicker>Substitute</Kicker>
            {data?.substitutes.done.map((d) => (
              <div key={d.sessionId} className="text-[13px] opacity-90">
                {d.label} <b className="font-semibold">{d.name}</b> · students and both teachers notified.
              </div>
            ))}
            {data?.substitutes.needed.map((n) => (
              <div key={n.sessionId} className="grid gap-2">
                <div className="text-[13px] opacity-90">{n.label}</div>
                {data.canManage && (
                  <Select
                    aria-label="Assign substitute"
                    value=""
                    disabled={sub.isPending}
                    onChange={(e) => e.target.value && sub.mutate({ params: { id: n.sessionId }, body: { teacherUserId: e.target.value } })}
                    options={[{ value: '', label: 'Assign substitute…' }, ...n.options.map((o) => ({ value: o.userId, label: o.label, disabled: o.status === 'on_leave' }))]}
                  />
                )}
              </div>
            ))}
            {data && data.substitutes.needed.length === 0 && data.substitutes.done.length === 0 && <div className="text-[13px] opacity-80">No teacher on approved leave this week or next. Approving leave flags their sessions here.</div>}
          </Card>
        </div>
      </div>
      {data && <SessionDialog state={dialog} week={data} onClose={closeDialog} />}
    </Page>
  );
}

function WeekGrid({ data, visible, onEdit, onAdd }: { data: AcadTimetableWeek; visible: (s: AcadSessionChip) => boolean; onEdit: (c: AcadSessionChip) => void; onAdd: (date: string, start: string) => void }) {
  const cols = data.days.length;
  return (
    <div className="overflow-x-auto">
      <div className="grid" style={{ gridTemplateColumns: `64px repeat(${cols}, minmax(120px, 1fr))`, minWidth: cols === 7 ? 920 : 800 }} role="grid" aria-label={`Week ${data.weekNumber}`}>
        <div className="px-2 py-2.5 border-b border-divider" />
        {data.days.map((d) => (
          <div key={d.date} className="px-2 py-2.5 border-b border-l border-divider text-[11px] tracking-[0.08em] uppercase text-neutral-600" role="columnheader">
            {d.label}
            {d.holiday && <div className="normal-case tracking-normal text-[10px] text-ink">{d.holiday}</div>}
          </div>
        ))}
        {data.slots.map((slot) => (
          <Row key={slot} slot={slot} data={data} visible={visible} onEdit={onEdit} onAdd={onAdd} />
        ))}
      </div>
    </div>
  );
}

function Row({ slot, data, visible, onEdit, onAdd }: { slot: string; data: AcadTimetableWeek; visible: (s: AcadSessionChip) => boolean; onEdit: (c: AcadSessionChip) => void; onAdd: (date: string, start: string) => void }) {
  return (
    <>
      <div className="p-2 text-xs text-neutral-600 border-b border-divider tabular">{slot}</div>
      {data.days.map((d) => {
        const items = data.sessions.filter((s) => s.date === d.date && s.slot === slot && visible(s));
        return (
          <div
            key={d.date}
            className={cn('p-1.5 border-l border-b border-divider min-h-[68px] grid gap-1 content-start', d.holiday && 'bg-neutral-100/60')}
            onDoubleClick={() => onAdd(d.date, slot)}
            data-testid={`cell-${d.date}-${slot}`}
          >
            {items.map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => onEdit(it)}
                title={`${it.editable ? 'Edit session' : (it.lockedReason ?? '')}${STYLE_NOTE[it.style]}`}
                aria-label={`${it.batchCode} ${d.label} ${it.start}${STYLE_NOTE[it.style]}`}
                data-testid="session-chip"
                data-style={it.style}
                className={cn('px-2 py-1.5 text-xs border text-left cursor-pointer w-full font-[inherit] hover:outline-2 hover:outline-accent hover:outline-offset-1 focus-visible:outline-2 focus-visible:outline-accent', CHIP_STYLE[it.style])}
              >
                <b className="font-semibold">{it.batchCode}</b>
                <div className="opacity-85 text-[11px] leading-snug">{it.sub}</div>
              </button>
            ))}
          </div>
        );
      })}
    </>
  );
}
