'use client';

import { academicsBatchesContract, referenceContract, type RouteBody, type AcadBatchInput, type AcadBatchRow, type AcadBatchStatus, type AcadOffering } from '@exatech/contracts';
import { addDays, addMonths, DEFAULT_SLOTS, formatDayMonth, mondayOf, todayIST } from '@exatech/domain';
import { Button, Checkbox, Dialog, Field, Icon, Input, Issue, Select, Skeleton, Tag } from '@exatech/ui';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useMe } from '@/components/me-context';
import { callApi, type ApiError } from '@/lib/api';
import { useApi, useApiMutation } from '@/lib/hooks';

const WEEKDAYS = [
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
  { value: '0', label: 'Sunday' },
];
const MODES = [
  { value: 'offline', label: 'Offline' },
  { value: 'hybrid', label: 'Hybrid · Meet link' },
  { value: 'online', label: 'Online' },
];
const STATUS_LABEL: Record<AcadBatchStatus, string> = { planned: 'Planned', open: 'Open for admission', running: 'Running', waitlist: 'Waitlist', completed: 'Completed', cancelled: 'Cancelled' };

function useReference() {
  return useApi(referenceContract.get, {}, { staleTime: 30 * 60_000 });
}

function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/* ───────────────────────── New batch ───────────────────────── */

export function NewBatchDialog({ open, onClose, offerings, batches }: { open: boolean; onClose: () => void; offerings: AcadOffering[]; batches: AcadBatchRow[] }) {
  const me = useMe();
  const ref = useReference();
  const router = useRouter();
  const pathname = usePathname();
  const fixedBranch = me.branch.selectedId ?? (me.branch.allowed.length === 1 ? me.branch.allowed[0]!.id : '');
  const nextMonday = addDays(mondayOf(todayIST()), 7);
  const [branchId, setBranchId] = useState(fixedBranch);
  const [courseId, setCourseId] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState(nextMonday);
  const [endDate, setEndDate] = useState(addMonths(nextMonday, 4));
  const [capacity, setCapacity] = useState('24');
  const [roomId, setRoomId] = useState('');
  const [mode, setMode] = useState<'offline' | 'online' | 'hybrid'>('offline');
  const [feePlanId, setFeePlanId] = useState('');
  const [teacherUserId, setTeacher] = useState('');
  const [subjectName, setSubject] = useState('');
  const [slots, setSlots] = useState<{ weekday: number; start: string }[]>([{ weekday: 1, start: '09:00' }]);

  useEffect(() => {
    if (!open) return;
    setBranchId(fixedBranch);
    setCourseId('');
    setCode('');
    setName('');
    setStartDate(nextMonday);
    setEndDate(addMonths(nextMonday, 4));
    setCapacity('24');
    setRoomId('');
    setTeacher('');
    setSubject('');
    setSlots([{ weekday: 1, start: '09:00' }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const branchOfferings = offerings.filter((o) => !branchId || o.branchId === branchId);
  const course = ref.data?.courses.find((c) => c.id === courseId);
  const rooms = (ref.data?.rooms ?? []).filter((r) => r.branchId === branchId);
  const plans = (ref.data?.feePlans ?? []).filter((p) => p.courseId === courseId && (!p.branchId || p.branchId === branchId));
  const branchName = me.branch.allowed.find((b) => b.id === branchId)?.name ?? 'this branch';
  useEffect(() => {
    // Reference data may arrive after the course was picked: default the subject then.
    if (courseId && course?.subjects[0]) setSubject((cur) => cur || course.subjects[0]!.name);
  }, [courseId, course]);
  const dup = code.trim() && batches.some((b) => b.branchId === branchId && b.code.toUpperCase() === code.trim().toUpperCase());

  const pickCourse = (id: string) => {
    setCourseId(id);
    const o = branchOfferings.find((x) => x.courseId === id);
    const c = ref.data?.courses.find((x) => x.id === id);
    if (o) {
      setMode(o.modality);
      setFeePlanId(o.defaultFeePlanId ?? '');
      setEndDate(addMonths(startDate, o.durationMonths));
      if (!code) {
        const n = batches.filter((b) => b.courseCode === o.courseCode && b.branchId === o.branchId).length;
        setCode(`${o.courseCode}-${String.fromCharCode(65 + n)}`);
      }
    }
    setSubject(c?.subjects[0]?.name ?? '');
  };

  const body: AcadBatchInput | null =
    courseId && code.trim().length >= 2 && teacherUserId && subjectName.trim().length >= 2 && slots.length && Number(capacity) > 0
      ? {
          ...(branchId && branchId !== me.branch.selectedId ? { branchId } : {}),
          courseId,
          code: code.trim().toUpperCase(),
          name: name.trim() || null,
          startDate,
          endDate,
          capacity: Number(capacity),
          roomId: roomId || null,
          mode,
          feePlanId: feePlanId || null,
          teacherUserId,
          subjectName: subjectName.trim(),
          slots,
        }
      : null;
  const bodyKey = JSON.stringify(body);
  const debouncedKey = useDebounced(bodyKey);
  const debounced = useMemo(() => JSON.parse(debouncedKey) as AcadBatchInput | null, [debouncedKey]);
  const plan = useQuery({
    queryKey: ['api', 'academics', 'batches', 'plan', debounced],
    queryFn: () => callApi(academicsBatchesContract.plan, { body: debounced! }),
    enabled: open && !!debounced && !dup,
    retry: false,
    staleTime: 0,
  });
  const create = useApiMutation(academicsBatchesContract.create, {
    invalidate: [['academics'], ['reference']],
    success: (d) => `${d.code} created · sessions generated`,
    onSuccess: (d) => {
      onClose();
      router.replace(`${pathname}?batch=${encodeURIComponent(d.code)}`);
    },
  });
  const needed: string[] = [];
  if (!courseId) needed.push('Choose the course');
  if (code.trim().length < 2) needed.push('Enter a batch code');
  if (!teacherUserId) needed.push('Choose the teacher');
  if (subjectName.trim().length < 2) needed.push('Enter the subject');
  if (!slots.length) needed.push('Add at least one weekly slot');
  const planErr = plan.error as ApiError | null;
  const blocked = !!dup || needed.length > 0 || !plan.data?.ok || plan.isFetching || bodyKey !== debouncedKey;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={620}
      kicker={`Courses & batches · ${branchName}`}
      title="New batch"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={blocked} loading={create.isPending} onClick={() => body && create.mutate({ body })}>
            Create batch
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-2.5">
        {!fixedBranch && (
          <Field label="Branch" className="col-span-2">
            <Select value={branchId} onChange={(e) => setBranchId(e.target.value)} placeholder="Choose…" options={me.branch.allowed.map((b) => ({ value: b.id, label: b.name }))} />
          </Field>
        )}
        <Field label="Course">
          <Select value={courseId} onChange={(e) => pickCourse(e.target.value)} placeholder="Choose…" options={branchOfferings.map((o) => ({ value: o.courseId, label: `${o.courseCode} · ${o.courseName}` }))} />
        </Field>
        <Field label="Batch code" error={dup ? `${code.trim().toUpperCase()} already exists in ${branchName}` : null}>
          <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="DM-C" invalid={!!dup} maxLength={16} />
        </Field>
        <Field label="Name (optional)" className="col-span-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={course && code ? `${course.name} · ${code.toUpperCase()}` : 'Digital Marketing · weekday mornings'} />
        </Field>
        <Field label="Starts">
          <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </Field>
        <Field label="Ends">
          <Input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
        </Field>
        <Field label="Capacity (seats)">
          <Input type="number" min={1} max={500} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
        </Field>
        <Field label="Room">
          <Select value={roomId} onChange={(e) => setRoomId(e.target.value)} placeholder={mode === 'online' ? 'No room (online)' : 'Choose…'} options={rooms.map((r) => ({ value: r.id, label: `${r.name} · ${r.capacity} seats` }))} />
        </Field>
        <Field label="Mode">
          <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} options={MODES} />
        </Field>
        <Field label="Fee plan">
          <Select value={feePlanId} onChange={(e) => setFeePlanId(e.target.value)} placeholder={courseId ? 'Offering default' : 'Choose the course first'} options={plans.map((p) => ({ value: p.id, label: p.name }))} />
        </Field>
        <Field label="Teacher">
          <Select value={teacherUserId} onChange={(e) => setTeacher(e.target.value)} placeholder="Choose…" options={(ref.data?.teachers ?? []).map((t) => ({ value: t.id, label: t.name }))} />
        </Field>
        <Field label="Subject (one per teacher per batch)">
          <Input list="new-batch-subjects" value={subjectName} onChange={(e) => setSubject(e.target.value)} placeholder="Search · SEO & analytics" />
        </Field>
        <datalist id="new-batch-subjects">
          {course?.subjects.map((s) => (
            <option key={s.id} value={s.name} />
          ))}
        </datalist>
      </div>

      <div className="grid gap-1.5">
        <div className="text-xs text-ink/70">Weekly schedule (2-hour slots)</div>
        {slots.map((slot, i) => (
          <div key={i} className="flex gap-2 items-center">
            <Select
              aria-label={`Slot ${i + 1} day`}
              className="flex-1"
              value={String(slot.weekday)}
              onChange={(e) => setSlots(slots.map((x, j) => (j === i ? { ...x, weekday: Number(e.target.value) } : x)))}
              options={WEEKDAYS}
            />
            <Select aria-label={`Slot ${i + 1} start`} className="flex-1" value={slot.start} onChange={(e) => setSlots(slots.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} options={DEFAULT_SLOTS.map((t) => ({ value: t, label: `${t} – ${String(Number(t.slice(0, 2)) + 2).padStart(2, '0')}${t.slice(2)}` }))} />
            <Button variant="secondary" size="iconSm" aria-label="Remove slot" disabled={slots.length === 1} onClick={() => setSlots(slots.filter((_, j) => j !== i))}>
              <Icon name="x" size={14} />
            </Button>
          </div>
        ))}
        <div>
          <Button variant="ghost" size="sm" onClick={() => setSlots([...slots, { weekday: ((slots[slots.length - 1]?.weekday ?? 0) + 2) % 7 || 1, start: slots[slots.length - 1]?.start ?? '09:00' }])}>
            <Icon name="plus" size={14} /> Add slot
          </Button>
        </div>
      </div>

      <div className="grid gap-1" aria-live="polite">
        {needed.map((n) => (
          <Issue key={n} kind="needed">
            {n}
          </Issue>
        ))}
        {needed.length === 0 && !dup && (plan.isFetching || bodyKey !== debouncedKey) && <Skeleton className="h-5 w-2/3" />}
        {planErr && <Issue kind="blocked">{planErr.message}</Issue>}
        {plan.data && !plan.isFetching && bodyKey === debouncedKey && (
          <>
            {plan.data.issues.map((i) => (
              <Issue key={i} kind="blocked">
                {i}
              </Issue>
            ))}
            {plan.data.ok && (
              <Issue kind="ok">
                {plan.data.sessions} sessions from {plan.data.firstDate ? formatDayMonth(plan.data.firstDate) : '—'} to {plan.data.lastDate ? formatDayMonth(plan.data.lastDate) : '—'}
                {plan.data.suppressed ? ` · ${plan.data.suppressed} suppressed for holidays` : ''}
                {plan.data.flagged ? ` · ${plan.data.flagged} flagged for approved leave` : ''} · no room or teacher clash
              </Issue>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

/* ───────────────────────── Edit batch ───────────────────────── */

export function EditBatchDialog({ batch, onClose, onAssign }: { batch: AcadBatchRow | null; onClose: () => void; onAssign: (b: AcadBatchRow) => void }) {
  const ref = useReference();
  const [name, setName] = useState('');
  const [startDate, setStart] = useState('');
  const [endDate, setEnd] = useState('');
  const [capacity, setCapacity] = useState('');
  const [roomId, setRoomId] = useState('');
  const [mode, setMode] = useState<'offline' | 'online' | 'hybrid'>('offline');
  const [meetLink, setMeetLink] = useState('');
  const [feePlanId, setFeePlanId] = useState('');
  const [status, setStatus] = useState<AcadBatchStatus>('planned');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (!batch) return;
    setName(batch.name ?? '');
    setStart(batch.startDate);
    setEnd(batch.endDate);
    setCapacity(String(batch.capacity));
    setRoomId(batch.roomId ?? '');
    setMode(batch.mode);
    setMeetLink(batch.meetLink ?? '');
    setFeePlanId(batch.feePlanId ?? '');
    setStatus(batch.status);
    setReason('');
  }, [batch]);
  const update = useApiMutation(academicsBatchesContract.update, { invalidate: [['academics'], ['reference']], success: (d) => `${d.code} updated`, onSuccess: onClose });
  if (!batch) return <Dialog open={false} onOpenChange={onClose} title="Edit batch" />;
  const rooms = (ref.data?.rooms ?? []).filter((r) => r.branchId === batch.branchId);
  const plans = (ref.data?.feePlans ?? []).filter((p) => p.courseId === batch.courseId && (!p.branchId || p.branchId === batch.branchId));
  const capErr = Number(capacity) < batch.enrolled ? `${batch.code} has ${batch.enrolled} active students — capacity cannot go below that` : null;
  const patch: RouteBody<typeof academicsBatchesContract.update> = {};
  if ((name || null) !== batch.name) patch.name = name || null;
  if (startDate !== batch.startDate) patch.startDate = startDate;
  if (endDate !== batch.endDate) patch.endDate = endDate;
  if (Number(capacity) !== batch.capacity) patch.capacity = Number(capacity);
  if ((roomId || null) !== batch.roomId) patch.roomId = roomId || null;
  if (mode !== batch.mode) patch.mode = mode;
  if ((meetLink || null) !== batch.meetLink) patch.meetLink = meetLink || null;
  if ((feePlanId || null) !== batch.feePlanId) patch.feePlanId = feePlanId || null;
  if (status !== batch.status) patch.status = status;
  if (reason.trim()) patch.reason = reason.trim();
  const needsReason = status === 'cancelled' && !reason.trim();
  const dirty = Object.keys(patch).filter((k) => k !== 'reason').length > 0;
  const datesLocked = batch.status === 'running';
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      width={560}
      kicker={`${batch.courseName} · ${batch.branchCode}`}
      title={`Edit batch · ${batch.code}`}
      footerAlign="between"
      footer={
        <>
          <Button variant="ghost" onClick={() => onAssign(batch)}>
            Assign teacher / subject
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!dirty || !!capErr || needsReason} loading={update.isPending} onClick={() => update.mutate({ params: { id: batch.id }, body: patch })}>
              Save batch
            </Button>
          </div>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Name" className="col-span-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Starts" hint={datesLocked ? 'Locked while running' : undefined}>
          <Input type="date" value={startDate} disabled={datesLocked} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Ends">
          <Input type="date" value={endDate} min={startDate} onChange={(e) => setEnd(e.target.value)} />
        </Field>
        <Field label={`Capacity · ${batch.enrolled} enrolled`} error={capErr}>
          <Input type="number" min={batch.enrolled || 1} value={capacity} invalid={!!capErr} onChange={(e) => setCapacity(e.target.value)} />
        </Field>
        <Field label="Room">
          <Select value={roomId} onChange={(e) => setRoomId(e.target.value)} placeholder="No room (online)" options={rooms.map((r) => ({ value: r.id, label: `${r.name} · ${r.capacity} seats` }))} />
        </Field>
        <Field label="Mode">
          <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} options={MODES} />
        </Field>
        <Field label="Fee plan (new admissions)">
          <Select value={feePlanId} onChange={(e) => setFeePlanId(e.target.value)} placeholder="None" options={plans.map((p) => ({ value: p.id, label: p.name }))} />
        </Field>
        {mode !== 'offline' && (
          <Field label="Meet link" className="col-span-2">
            <Input value={meetLink} onChange={(e) => setMeetLink(e.target.value)} placeholder="https://meet.google.com/…" />
          </Field>
        )}
        <Field label="Status" className="col-span-2">
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as AcadBatchStatus)}
            options={[{ value: batch.status, label: `${STATUS_LABEL[batch.status]} (current)` }, ...batch.nextStatuses.map((s) => ({ value: s, label: `→ ${STATUS_LABEL[s]}` }))]}
          />
        </Field>
        {status === 'cancelled' && (
          <Field label="Reason (logged, sent to enrolled students)" className="col-span-2" error={needsReason ? 'Required to cancel' : null}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Not enough admissions" />
          </Field>
        )}
      </div>
      <div className="flex gap-1.5 flex-wrap text-[13px] items-center">
        <span className="text-xs text-ink/70">Teaching:</span>
        {batch.assignments.length === 0 && <Tag variant="ink">No teacher assigned</Tag>}
        {batch.assignments.map((a) => (
          <Tag key={a.teacherUserId} variant={a.isPrimary ? 'accent' : 'neutral'}>
            {a.teacherName} · {a.subjectName}
          </Tag>
        ))}
      </div>
      {Boolean(patch.startDate || patch.endDate || patch.roomId !== undefined || patch.mode) && <Issue kind="needed">Future sessions are reshaped and re-validated on save; the batch is notified</Issue>}
    </Dialog>
  );
}

/* ───────────────────────── Assign teacher ───────────────────────── */

export function AssignTeacherDialog({ batch, onClose }: { batch: AcadBatchRow | null; onClose: () => void }) {
  const ref = useReference();
  const [teacher, setTeacher] = useState('');
  const [subject, setSubject] = useState('');
  const [primary, setPrimary] = useState(true);
  const [replace, setReplace] = useState('');
  useEffect(() => {
    setTeacher('');
    setSubject(batch?.subjectName ?? '');
    setPrimary(true);
    setReplace('');
  }, [batch]);
  const assign = useApiMutation(academicsBatchesContract.assign, { invalidate: [['academics'], ['reference']], success: (d) => `${d.code} · teacher assigned`, onSuccess: onClose });
  const subjects = useMemo(() => ref.data?.courses.find((c) => c.id === batch?.courseId)?.subjects ?? [], [ref.data, batch]);
  if (!batch) return <Dialog open={false} onOpenChange={onClose} title="Assign teacher" />;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      kicker={`${batch.code} · ${batch.courseName}`}
      title="Assign teacher / subject"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!teacher || subject.trim().length < 2}
            loading={assign.isPending}
            onClick={() => assign.mutate({ params: { id: batch.id }, body: { teacherUserId: teacher, subjectName: subject.trim(), isPrimary: primary, replaceTeacherUserId: replace || null } })}
          >
            Assign
          </Button>
        </>
      }
    >
      <Field label="Teacher">
        <Select value={teacher} onChange={(e) => setTeacher(e.target.value)} placeholder="Choose…" options={(ref.data?.teachers ?? []).map((t) => ({ value: t.id, label: t.name }))} />
      </Field>
      <Field label="Subject (one per teacher in this batch)">
        <Select value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Choose…" options={subjects.map((s) => ({ value: s.name, label: s.name }))} />
      </Field>
      <Checkbox checked={primary} onChange={setPrimary} label="Primary teacher (shown on the batch, default for new sessions)" />
      {batch.assignments.length > 0 && (
        <Field label="Hand over from (optional)" hint="Their future sessions in this batch move to the new teacher">
          <Select value={replace} onChange={(e) => setReplace(e.target.value)} placeholder="Keep everyone" options={batch.assignments.filter((a) => a.teacherUserId !== teacher).map((a) => ({ value: a.teacherUserId, label: `${a.teacherName} · ${a.subjectName}` }))} />
        </Field>
      )}
    </Dialog>
  );
}

/* ───────────────────────── Offer a course ───────────────────────── */

export function OfferCourseDialog({ open, onClose, offerings }: { open: boolean; onClose: () => void; offerings: AcadOffering[] }) {
  const me = useMe();
  const ref = useReference();
  const fixedBranch = me.branch.selectedId ?? (me.branch.allowed.length === 1 ? me.branch.allowed[0]!.id : '');
  const [branchId, setBranchId] = useState(fixedBranch);
  const [courseId, setCourseId] = useState('');
  const [planId, setPlanId] = useState('');
  useEffect(() => {
    if (open) {
      setBranchId(fixedBranch);
      setCourseId('');
      setPlanId('');
    }
  }, [open, fixedBranch]);
  const offered = new Set(offerings.filter((o) => o.branchId === branchId).map((o) => o.courseId));
  const courses = (ref.data?.courses ?? []).filter((c) => !offered.has(c.id));
  const plans = (ref.data?.feePlans ?? []).filter((p) => p.courseId === courseId && (!p.branchId || p.branchId === branchId));
  const offer = useApiMutation(academicsBatchesContract.offer, { invalidate: [['academics']], success: (d) => `${d.courseName} offered at ${d.branchCode}`, onSuccess: onClose });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      kicker="Courses & batches"
      title="Offer a course here"
      description="Courses are defined once for the institution; offering one here lets this branch run batches of it with a default fee plan."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!courseId || !planId || !branchId} loading={offer.isPending} onClick={() => offer.mutate({ body: { courseId, defaultFeePlanId: planId, ...(branchId !== me.branch.selectedId ? { branchId } : {}) } })}>
            Offer course
          </Button>
        </>
      }
    >
      {!fixedBranch && (
        <Field label="Branch">
          <Select value={branchId} onChange={(e) => setBranchId(e.target.value)} placeholder="Choose…" options={me.branch.allowed.map((b) => ({ value: b.id, label: b.name }))} />
        </Field>
      )}
      <Field label="Course">
        <Select
          value={courseId}
          onChange={(e) => {
            setCourseId(e.target.value);
            setPlanId('');
          }}
          placeholder={courses.length ? 'Choose…' : 'Every course is already offered here'}
          options={courses.map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))}
        />
      </Field>
      <Field label="Default fee plan">
        <Select value={planId} onChange={(e) => setPlanId(e.target.value)} placeholder={courseId ? 'Choose…' : 'Choose the course first'} options={plans.map((p) => ({ value: p.id, label: p.name }))} />
      </Field>
    </Dialog>
  );
}
