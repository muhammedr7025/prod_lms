'use client';

import { academicsTimetableContract, type AcadSessionChip, type AcadSessionInput, type AcadTimetableWeek } from '@exatech/contracts';
import { DEFAULT_SLOTS } from '@exatech/domain';
import { Button, Dialog, Field, Input, Issue, Select, Skeleton, toast } from '@exatech/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { callApi, type ApiError } from '@/lib/api';
import { invalidatePrefixes, useApiMutation } from '@/lib/hooks';

const MODES = [
  { value: 'offline', label: 'Offline' },
  { value: 'hybrid', label: 'Hybrid · Meet link' },
  { value: 'online', label: 'Online' },
];

export interface SessionDialogState {
  mode: 'add' | 'edit';
  chip?: AcadSessionChip;
  date?: string;
  start?: string;
  batchId?: string;
}

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Add / edit a timetable session. Every blocking issue states its reason; the server re-validates on save. */
export function SessionDialog({ state, week, onClose }: { state: SessionDialogState | null; week: AcadTimetableWeek; onClose: () => void }) {
  const qc = useQueryClient();
  const [batchId, setBatchId] = useState('');
  const [teacherUserId, setTeacher] = useState('');
  const [subjectName, setSubject] = useState('');
  const [date, setDate] = useState('');
  const [start, setStart] = useState<string>(DEFAULT_SLOTS[0]);
  const [roomId, setRoomId] = useState('');
  const [mode, setMode] = useState<'offline' | 'online' | 'hybrid'>('offline');

  useEffect(() => {
    if (!state) return;
    const c = state.chip;
    if (c) {
      setBatchId(c.batchId);
      setTeacher(c.teacherUserId);
      setSubject(c.subjectName);
      setDate(c.date);
      setStart(c.start);
      setRoomId(c.roomId ?? '');
      setMode(c.mode);
    } else {
      setBatchId('');
      setTeacher('');
      setSubject('');
      setDate(state.date ?? week.days.find((d) => !d.holiday)?.date ?? week.days[0]!.date);
      setStart(state.start ?? DEFAULT_SLOTS[0]);
      setRoomId('');
      setMode('offline');
      if (state.batchId) pickBatch(state.batchId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const batch = week.batches.find((b) => b.id === batchId);
  const rooms = week.rooms.filter((r) => !batch || r.branchId === batch.branchId);
  function pickBatch(id: string) {
    setBatchId(id);
    const b = week.batches.find((x) => x.id === id);
    if (!b) return;
    const primary = b.assignments.find((a) => a.isPrimary) ?? b.assignments[0];
    if (primary) {
      setTeacher(primary.teacherUserId);
      setSubject(primary.subjectName);
    }
    setRoomId(b.roomId ?? '');
    setMode(b.mode);
  }
  const pickTeacher = (id: string) => {
    setTeacher(id);
    const a = batch?.assignments.find((x) => x.teacherUserId === id);
    if (a) setSubject(a.subjectName);
  };

  const input: AcadSessionInput | null = batchId && teacherUserId && subjectName.trim().length >= 2 && date ? { batchId, teacherUserId, subjectName: subjectName.trim(), date, start, roomId: roomId || null, mode } : null;
  const inputKey = JSON.stringify(input);
  const debouncedKey = useDebounced(inputKey);
  const debounced = useMemo(() => JSON.parse(debouncedKey) as AcadSessionInput | null, [debouncedKey]);
  const validation = useQuery({
    queryKey: ['api', 'academics', 'sessions', 'validate', state?.chip?.id ?? 'new', debounced],
    queryFn: () => callApi(academicsTimetableContract.validate, { body: { ...debounced!, ...(state?.chip ? { id: state.chip.id } : {}) } }),
    enabled: !!state && !!debounced,
    retry: false,
    staleTime: 0,
  });
  const done = () => {
    onClose();
  };
  const create = useApiMutation(academicsTimetableContract.create, { invalidate: [['academics']], success: 'Session added · students and teacher notified', onSuccess: done });
  const update = useApiMutation(academicsTimetableContract.update, { invalidate: [['academics']], success: 'Session saved · students and teacher notified', onSuccess: done });
  const remove = useApiMutation(academicsTimetableContract.remove, {
    invalidate: [['academics']],
    success: false,
    onSuccess: (_d, args) => {
      done();
      toast('Session removed · the batch was notified', {
        undo: async () => {
          try {
            await callApi(academicsTimetableContract.restore, { params: args.params });
            await invalidatePrefixes(qc, [['academics']]);
            toast('Session restored');
          } catch (err) {
            toast.error((err as ApiError).message);
          }
        },
      });
    },
  });

  if (!state) return <Dialog open={false} onOpenChange={onClose} title="Session" />;
  const chip = state.chip;
  const needed: string[] = [];
  if (!batchId) needed.push('Choose the batch');
  else if (!teacherUserId) needed.push('Choose the teacher');
  else if (subjectName.trim().length < 2) needed.push('Enter the subject');
  const stale = inputKey !== debouncedKey || validation.isFetching;
  const issues = validation.data?.issues ?? [];
  const blocked = needed.length > 0 || stale || !validation.data?.ok;
  const slotOptions = [...new Set([...DEFAULT_SLOTS, start])].sort();
  const dayLabel = week.days.find((d) => d.date === (chip?.date ?? date))?.label ?? chip?.date ?? '';
  const save = () => {
    if (!input) return;
    if (chip) update.mutate({ params: { id: chip.id }, body: input });
    else create.mutate({ body: input });
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      width={560}
      kicker={`Timetable · ${week.branchLabel}`}
      title={chip ? `Edit session · ${chip.batchCode} · ${dayLabel} ${chip.start}` : 'Add session'}
      footerAlign="between"
      footer={
        <>
          <div>
            {chip && (
              <Button variant="ghost" loading={remove.isPending} onClick={() => remove.mutate({ params: { id: chip.id } })}>
                Remove session
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={blocked} loading={create.isPending || update.isPending} onClick={save}>
              Save session
            </Button>
          </div>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Batch">
          <Select value={batchId} disabled={!!chip} onChange={(e) => pickBatch(e.target.value)} placeholder="Choose…" options={week.batches.map((b) => ({ value: b.id, label: b.code }))} />
        </Field>
        <Field label="Teacher">
          <Select value={teacherUserId} onChange={(e) => pickTeacher(e.target.value)} placeholder="Choose…" options={week.teachers.map((t) => ({ value: t.id, label: t.name }))} />
        </Field>
        <Field label="Subject (defaults from the teacher's assignment for this batch)" className="col-span-2">
          <Input value={subjectName} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Search · SEO & analytics" />
        </Field>
        <Field label="Day">
          <Select value={date} onChange={(e) => setDate(e.target.value)} options={week.days.map((d) => ({ value: d.date, label: d.holiday ? `${d.label} · ${d.holiday}` : d.label }))} />
        </Field>
        <Field label="Start (2 h slot)">
          <Select value={start} onChange={(e) => setStart(e.target.value)} options={slotOptions} />
        </Field>
        <Field label="Room">
          <Select value={roomId} onChange={(e) => setRoomId(e.target.value)} options={[{ value: '', label: 'No room (online)' }, ...rooms.map((r) => ({ value: r.id, label: `${r.name} · ${r.capacity}` }))]} />
        </Field>
        <Field label="Mode">
          <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} options={MODES} />
        </Field>
      </div>
      <div className="grid gap-1 text-[13px]" aria-live="polite" data-testid="session-issues">
        {needed.map((n) => (
          <Issue key={n} kind="needed">
            {n}
          </Issue>
        ))}
        {needed.length === 0 && stale && <Skeleton className="h-5 w-3/4" />}
        {needed.length === 0 && !stale && validation.error && <Issue kind="blocked">{validation.error.message}</Issue>}
        {needed.length === 0 &&
          !stale &&
          issues.map((i) => (
            <Issue key={i.code + i.message} kind="blocked">
              {i.message}
            </Issue>
          ))}
        {needed.length === 0 && !stale && validation.data?.ok && <Issue kind="ok">No room or teacher clash · students and teacher will be notified on save</Issue>}
      </div>
    </Dialog>
  );
}
