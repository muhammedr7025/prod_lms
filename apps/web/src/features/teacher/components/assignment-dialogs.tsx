'use client';

import { teachingAssignmentsContract, TEACH_LATE_POLICIES, type TeachAssignmentCard, type TeachBatch } from '@exatech/contracts';
import { LATE_POLICY_LABEL } from '@exatech/domain';
import { Button, cn, Dialog, EmptyState, Field, Input, Select, Skeleton, Textarea, toast } from '@exatech/ui';
import { useEffect, useState } from 'react';
import { callApi } from '@/lib/api';
import { useApi, useApiMutation } from '@/lib/hooks';
import { addDaysClient, NeededList, todayISTClient, toLocalInput } from './parts';

type Policy = (typeof TEACH_LATE_POLICIES)[number];

/* ───────────────────────── New assignment ───────────────────────── */

export function NewAssignmentDialog({ open, onOpenChange, batches, defaultBatchId }: { open: boolean; onOpenChange: (o: boolean) => void; batches: TeachBatch[]; defaultBatchId?: string }) {
  const [title, setTitle] = useState('');
  const [batchId, setBatchId] = useState('');
  const [due, setDue] = useState('');
  const [max, setMax] = useState('50');
  const [late, setLate] = useState<Policy>('minus_10_per_day');
  const [rubric, setRubric] = useState('');
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setBatchId(defaultBatchId ?? batches[0]?.id ?? '');
    setDue(`${addDaysClient(todayISTClient(), 7)}T23:59`);
    setMax('50');
    setLate('minus_10_per_day');
    setRubric('');
  }, [open, defaultBatchId, batches]);
  const create = useApiMutation(teachingAssignmentsContract.create, {
    invalidate: [['teaching']],
    success: 'Published to batch · students notified',
    onSuccess: () => onOpenChange(false),
  });
  const batch = batches.find((b) => b.id === batchId);
  const maxN = Number(max);
  const nowLocal = toLocalInput(new Date().toISOString());
  const issues = [
    ...(title.trim().length < 3 ? ['Title (at least 3 characters)'] : []),
    ...(!batchId ? ['Batch'] : []),
    ...(!due ? ['Due date and time'] : due <= nowLocal ? ['A due date in the future'] : []),
    ...(!Number.isInteger(maxN) || maxN < 1 ? ['Max marks (a whole number)'] : []),
  ];
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      kicker="Assignments"
      title="New assignment"
      width={520}
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={issues.length > 0}
            loading={create.isPending}
            onClick={() => create.mutate({ body: { batchId, title: title.trim(), dueDate: due.slice(0, 10), dueTime: due.slice(11, 16), maxMarks: maxN, latePolicy: late, instructions: rubric.trim() || undefined } })}
          >
            Publish to batch
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Title" className="col-span-2">
          <Input className="min-h-11" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Landing page audit" autoFocus maxLength={140} />
        </Field>
        <Field label={`Batch (${batch?.students ?? 0} students)`} className="max-sm:col-span-2">
          <Select className="min-h-11" value={batchId} onChange={(e) => setBatchId(e.target.value)} options={batches.map((b) => ({ value: b.id, label: b.code }))} />
        </Field>
        <Field label="Due" className="max-sm:col-span-2">
          <Input type="datetime-local" className="min-h-11" value={due} min={nowLocal} onChange={(e) => setDue(e.target.value)} />
        </Field>
        <Field label="Max marks">
          <Input className="min-h-11" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.replace(/[^\d]/g, ''))} />
        </Field>
        <Field label="Late policy">
          <Select className="min-h-11" value={late} onChange={(e) => setLate(e.target.value as Policy)} options={TEACH_LATE_POLICIES.map((p) => ({ value: p, label: LATE_POLICY_LABEL[p] }))} />
        </Field>
        <Field label="Rubric / instructions" className="col-span-2">
          <Textarea value={rubric} onChange={(e) => setRubric(e.target.value)} placeholder="What good looks like, file types, word limit" maxLength={4000} />
        </Field>
      </div>
      <NeededList items={issues} />
    </Dialog>
  );
}

/* ───────────────────────── Grade & release ───────────────────────── */

export function GradeDialog({ assignmentId, onOpenChange }: { assignmentId: string | null; onOpenChange: (o: boolean) => void }) {
  const open = !!assignmentId;
  const { data, isPending, error } = useApi(teachingAssignmentsContract.grading, { params: { id: assignmentId ?? '00000000-0000-0000-0000-000000000000' } }, { enabled: open, staleTime: 0 });
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [fb, setFb] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) {
      setMarks({});
      setFb({});
    }
  }, [open, assignmentId]);
  const grade = useApiMutation(teachingAssignmentsContract.grade, {
    invalidate: [['teaching']],
    success: (d) => `Released ${d.released} grade${d.released === 1 ? '' : 's'}${d.penalised ? ` · late penalty on ${d.penalised}` : ''}`,
    onSuccess: () => onOpenChange(false),
  });
  const max = data?.max ?? 0;
  const filled = (data?.rows ?? []).filter((r) => (marks[r.submissionId] ?? '').trim() !== '');
  const over = filled.filter((r) => Number(marks[r.submissionId]) > max || Number.isNaN(Number(marks[r.submissionId])));
  const late = filled.filter((r) => r.lateDays > 0).length;
  const hint = !data
    ? ''
    : data.rows.length === 0
      ? 'Nothing waiting — every submission is graded.'
      : over.length
        ? `${over.length} mark${over.length > 1 ? 's are' : ' is'} over the maximum of ${max} — fix before saving.`
        : `${filled.length} of ${data.rows.length} filled · empty rows stay queued for later${late ? ` · ${data.latePolicyLabel} applied to ${late} late` : ''}.`;

  const openFile = async (submissionId: string) => {
    try {
      const r = await callApi(teachingAssignmentsContract.file, { params: { id: submissionId } });
      window.open(r.url, '_blank', 'noopener');
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      kicker={data ? `${data.batchCode} · out of ${data.max}` : 'Assignments'}
      title={data ? `Grade · ${data.title}` : 'Grade'}
      width={600}
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={filled.length === 0 || over.length > 0}
            loading={grade.isPending}
            onClick={() =>
              assignmentId &&
              grade.mutate({ params: { id: assignmentId }, body: { grades: filled.map((r) => ({ submissionId: r.submissionId, marks: Number(marks[r.submissionId]), feedback: fb[r.submissionId]?.trim() || undefined })) } })
            }
          >
            Save &amp; release {filled.length}
          </Button>
        </>
      }
    >
      {error && <div className="text-[13px]">{error.message}</div>}
      {isPending && open && Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-[84px]" />)}
      {data?.rows.length === 0 && <EmptyState className="py-4" title="All graded" body="New submissions appear here as students hand in their work." />}
      <div className="grid gap-2">
        {data?.rows.map((r) => {
          const v = marks[r.submissionId] ?? '';
          const bad = v.trim() !== '' && (Number(v) > max || Number.isNaN(Number(v)));
          return (
            <div key={r.submissionId} className="grid grid-cols-[1fr_80px] gap-2 py-2 border-b border-divider items-start" data-testid="grade-row">
              <div className="min-w-0">
                <div className="font-medium text-sm">{r.name}</div>
                <div className="text-[11px] text-neutral-600">
                  {r.admissionNo ?? '—'} · <span className={cn(r.lateDays > 0 && 'text-ink font-medium')}>{r.lateLabel}</span>
                  {r.hasFile && (
                    <>
                      {' · '}
                      <button type="button" className="border-0 bg-transparent p-0 font-[inherit] text-accent-800 underline underline-offset-[3px] cursor-pointer min-h-6" onClick={() => void openFile(r.submissionId)}>
                        Open file
                      </button>
                    </>
                  )}
                </div>
                {r.text && <div className="text-xs text-neutral-700 mt-0.5 line-clamp-2">{r.text}</div>}
                <Input className="mt-1.5 min-h-9 text-[13px]" value={fb[r.submissionId] ?? ''} onChange={(e) => setFb((x) => ({ ...x, [r.submissionId]: e.target.value }))} placeholder="Feedback (optional)" aria-label={`Feedback for ${r.name}`} />
              </div>
              <Input
                className="min-h-11 text-center"
                inputMode="decimal"
                value={v}
                invalid={bad}
                onChange={(e) => setMarks((x) => ({ ...x, [r.submissionId]: e.target.value.replace(/[^\d.]/g, '') }))}
                placeholder={`/ ${max}`}
                aria-label={`Marks for ${r.name}`}
              />
            </div>
          );
        })}
      </div>
      {data && data.rows.length > 0 && <div className={cn('text-[13px]', over.length ? 'text-ink font-medium' : 'text-neutral-700')}>{hint}</div>}
    </Dialog>
  );
}

/* ───────────────────────── Remind non-submitters ───────────────────────── */

export function RemindDialog({ a, onOpenChange }: { a: TeachAssignmentCard | null; onOpenChange: (o: boolean) => void }) {
  const remind = useApiMutation(teachingAssignmentsContract.remind, {
    success: (d) => `Reminded ${d.reminded} student${d.reminded === 1 ? '' : 's'}`,
    onSuccess: () => onOpenChange(false),
  });
  return (
    <Dialog
      open={!!a}
      onOpenChange={onOpenChange}
      kicker={a ? `${a.batchCode} · due ${a.dueLabel}` : 'Assignments'}
      title={a ? `Remind ${a.notSubmitted} student${a.notSubmitted === 1 ? '' : 's'}?` : 'Remind'}
      width={420}
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" loading={remind.isPending} disabled={!a || a.notSubmitted === 0} onClick={() => a && remind.mutate({ params: { id: a.id } })}>
            Send reminder
          </Button>
        </>
      }
    >
      <div className="text-[13px] text-neutral-700">
        {a ? `They haven't submitted “${a.title}”. ` : ''}Each gets an in-app reminder and a WhatsApp message (where the student allows WhatsApp).
      </div>
    </Dialog>
  );
}

/* ───────────────────────── Extend due date ───────────────────────── */

export function ExtendDialog({ a, onOpenChange }: { a: TeachAssignmentCard | null; onOpenChange: (o: boolean) => void }) {
  const [due, setDue] = useState('');
  useEffect(() => {
    if (!a) return;
    const current = toLocalInput(String(a.dueAt));
    const base = current.slice(0, 10) < todayISTClient() ? todayISTClient() : current.slice(0, 10);
    setDue(`${addDaysClient(base, 2)}T${current.slice(11, 16)}`);
  }, [a]);
  const extend = useApiMutation(teachingAssignmentsContract.extend, {
    invalidate: [['teaching']],
    success: 'Due date extended · batch notified',
    onSuccess: () => onOpenChange(false),
  });
  const current = a ? toLocalInput(String(a.dueAt)) : '';
  const issues = !due ? ['New due date'] : due <= current ? ['A date after the current due date'] : due <= toLocalInput(new Date().toISOString()) ? ['A date in the future'] : [];
  return (
    <Dialog
      open={!!a}
      onOpenChange={onOpenChange}
      kicker={a ? `${a.batchCode} · due ${a.dueLabel}` : 'Assignments'}
      title={a ? `Extend · ${a.title}` : 'Extend'}
      width={420}
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" disabled={issues.length > 0} loading={extend.isPending} onClick={() => a && extend.mutate({ params: { id: a.id }, body: { dueDate: due.slice(0, 10), dueTime: due.slice(11, 16) } })}>
            Extend due date
          </Button>
        </>
      }
    >
      <Field label="New due">
        <Input type="datetime-local" className="min-h-11" value={due} min={current} onChange={(e) => setDue(e.target.value)} />
      </Field>
      <div className="text-[13px] text-neutral-700">The batch is notified; late penalties are counted from the new due date.</div>
      <NeededList items={issues} />
    </Dialog>
  );
}
