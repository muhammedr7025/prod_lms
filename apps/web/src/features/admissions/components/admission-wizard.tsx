'use client';

import { admissionsContract, salesContract, type AdmissionDetail, type AdmissionInput, type AdmissionOptions } from '@exatech/contracts';
import { buildSchedule, discountApprovalLevel, formatINR, formatPhone, isValidEmail, normalizePhone, quoteFee } from '@exatech/domain';
import { Button, Card, CardButton, CardTitle, Checkbox, cn, EmptyState, Field, Input, Issue, Kicker, Page, PageHeader, Select, Skeleton, Table, Tag, TD, toast } from '@exatech/ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi, uploadFile, type ApiError } from '@/lib/api';
import { invalidatePrefixes, useApi } from '@/lib/hooks';
import { MyApplications } from './my-applications';

const STEPS = ['Student details', 'Guardian', 'Batch', 'Fee plan', 'Documents & consent'];
const PURPOSES = ['Academic records', 'Fee communication', 'WhatsApp reminders'];
const DOC_KINDS = [
  { kind: 'id_proof', label: 'ID proof' },
  { kind: 'photo', label: 'Photo · passport size' },
  { kind: 'certificate', label: 'Qualification certificate' },
] as const;
type DocKind = (typeof DOC_KINDS)[number]['kind'];

interface Form {
  studentName: string;
  studentPhone: string;
  studentEmail: string;
  studentDob: string;
  studentAddress: string;
  guardianName: string;
  guardianRelationship: string;
  guardianPhone: string;
  guardianEmail: string;
  courseId: string;
  batchId: string;
  feePlanId: string;
  discountPct: string;
  discountReason: string;
  waitlist: boolean;
  dpdp: boolean;
  parental: boolean;
  referral: boolean;
  referralCode: string;
  docs: Record<DocKind, { fileId: string | null; label: string; uploaded: boolean }>;
}

const blankDocs = (): Form['docs'] => ({
  id_proof: { fileId: null, label: 'ID proof', uploaded: false },
  photo: { fileId: null, label: 'Photo · passport size', uploaded: false },
  certificate: { fileId: null, label: 'Qualification certificate', uploaded: false },
});

const BLANK: Form = {
  studentName: '',
  studentPhone: '',
  studentEmail: '',
  studentDob: '',
  studentAddress: '',
  guardianName: '',
  guardianRelationship: 'Father',
  guardianPhone: '',
  guardianEmail: '',
  courseId: '',
  batchId: '',
  feePlanId: '',
  discountPct: '0',
  discountReason: '',
  waitlist: false,
  dpdp: false,
  parental: false,
  referral: false,
  referralCode: '',
  docs: blankDocs(),
};

function ageOn(dob: string, today: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const [y, m, d] = dob.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

function fromDetail(a: AdmissionDetail, opts: AdmissionOptions | undefined): Form {
  const docs = blankDocs();
  for (const d of a.documents) {
    if (d.kind in docs) docs[d.kind as DocKind] = { fileId: d.fileId, label: d.label, uploaded: d.status === 'uploaded' || d.status === 'verified' };
  }
  const batch = opts?.batches.find((b) => b.id === a.batchId);
  return {
    studentName: a.studentName,
    studentPhone: a.studentPhone ? formatPhone(a.studentPhone) : '',
    studentEmail: a.studentEmail ?? '',
    studentDob: a.studentDob ?? '',
    studentAddress: a.studentAddress ?? '',
    guardianName: a.guardianName ?? '',
    guardianRelationship: a.guardianRelationship ?? 'Father',
    guardianPhone: a.guardianPhone ? formatPhone(a.guardianPhone) : '',
    guardianEmail: a.guardianEmail ?? '',
    courseId: batch?.courseId ?? '',
    batchId: a.batchId,
    feePlanId: a.feePlanId,
    discountPct: String(a.discountPct),
    discountReason: a.discountReason ?? '',
    waitlist: a.waitlist,
    dpdp: a.consent?.dpdp ?? false,
    parental: a.consent?.parental ?? false,
    referral: !!a.referralCode,
    referralCode: a.referralCode ?? '',
    docs,
  };
}

/** Sales · New admission — five steps prefilled from the lead, draft autosave, submit for approval. */
export function AdmissionWizard() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const leadId = params.get('lead');
  const idParam = params.get('id');
  const options = useApi(salesContract.admissionOptions, {}, { staleTime: 60_000 });
  const lead = useApi(salesContract.getLead, { params: { id: leadId ?? '' } }, { enabled: !!leadId });
  const resumeId = idParam ?? (lead.data && (lead.data.admissionStatus === 'draft' || lead.data.admissionStatus === 'returned') ? lead.data.admissionId : null);
  const existing = useApi(admissionsContract.get, { params: { id: resumeId ?? '' } }, { enabled: !!resumeId });

  const [f, setF] = useState<Form>(BLANK);
  const [step, setStep] = useState(1);
  const [admissionId, setAdmissionId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [submitted, setSubmitted] = useState<AdmissionDetail | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState<DocKind | null>(null);
  const [initKey, setInitKey] = useState<string | null>(null);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputs = useRef<Partial<Record<DocKind, HTMLInputElement | null>>>({});

  const opts = options.data;
  const today = opts?.today ?? new Date().toISOString().slice(0, 10);

  // Initialise once per source (existing application, lead, or blank).
  useEffect(() => {
    if (!opts) return;
    const key = resumeId ? `adm:${resumeId}` : leadId ? `lead:${leadId}` : 'blank';
    if (initKey === key) return;
    if (resumeId) {
      if (!existing.data) return;
      setF(fromDetail(existing.data, opts));
      setAdmissionId(existing.data.id);
      setSaveState('saved');
    } else if (leadId) {
      if (!lead.data) return;
      const l = lead.data;
      setF((x) => ({ ...BLANK, docs: blankDocs(), studentName: l.name, studentPhone: l.phone ? formatPhone(l.phone) : '', studentEmail: l.email ?? '', courseId: l.courseId ?? x.courseId }));
      setAdmissionId(null);
      setSaveState('idle');
    } else {
      setF({ ...BLANK, docs: blankDocs(), courseId: opts.courses[0]?.id ?? '' });
      setAdmissionId(null);
      setSaveState('idle');
    }
    setStep(1);
    setSubmitted(null);
    setErrors({});
    dirty.current = false;
    setInitKey(key);
  }, [opts, resumeId, leadId, existing.data, lead.data, initKey]);

  const batches = useMemo(() => (opts?.batches ?? []).filter((b) => b.courseId === f.courseId), [opts, f.courseId]);
  const batch = opts?.batches.find((b) => b.id === f.batchId) ?? null;
  const plans = useMemo(() => (opts?.plans ?? []).filter((p) => p.courseId === f.courseId && (!p.branchId || p.branchId === batch?.branchId)), [opts, f.courseId, batch?.branchId]);
  const plan = plans.find((p) => p.id === f.feePlanId) ?? null;

  // Default batch (first with seats) and plan (the batch's plan, else the course default).
  useEffect(() => {
    if (!opts || !f.courseId) return;
    if (!batches.some((b) => b.id === f.batchId)) {
      const b = batches.find((x) => x.seatsLeft > 0) ?? batches[0];
      if (b) setF((x) => ({ ...x, batchId: b.id, waitlist: b.seatsLeft <= 0 }));
    }
  }, [opts, f.courseId, batches, f.batchId]);
  useEffect(() => {
    if (!plans.length) return;
    if (!plans.some((p) => p.id === f.feePlanId)) {
      const p = plans.find((x) => x.id === batch?.feePlanId) ?? plans.find((x) => x.isDefault) ?? plans[0]!;
      setF((x) => ({ ...x, feePlanId: p.id }));
    }
  }, [plans, f.feePlanId, batch?.feePlanId]);

  const pct = Math.max(0, Math.min(100, Number(f.discountPct) || 0));
  const quote = plan ? quoteFee(plan.components, pct, plan.gstRate, plan.earlyPayDiscountPct) : null;
  const level = opts ? discountApprovalLevel(pct, opts.thresholds) : 'none';
  const age = ageOn(f.studentDob, today);
  const minor = age != null && age < 18;
  const phoneOk = normalizePhone(f.studentPhone) !== null;
  const gPhoneOk = !f.guardianPhone.trim() || normalizePhone(f.guardianPhone) !== null;

  const payload = useCallback(
    (draft: boolean): AdmissionInput & { draft: boolean } => ({
      leadId: leadId ?? existing.data?.leadId ?? null,
      studentName: f.studentName.trim(),
      studentPhone: f.studentPhone,
      studentEmail: f.studentEmail.trim() || null,
      studentDob: f.studentDob || null,
      studentAddress: f.studentAddress.trim() || null,
      guardianName: f.guardianName.trim() || null,
      guardianRelationship: f.guardianName.trim() ? f.guardianRelationship : null,
      guardianPhone: f.guardianPhone.trim() || null,
      guardianEmail: f.guardianEmail.trim() || null,
      batchId: f.batchId,
      feePlanId: f.feePlanId,
      discountPct: pct,
      discountReason: f.discountReason.trim() || null,
      waitlist: f.waitlist,
      consent: { dpdp: f.dpdp, purposes: f.dpdp ? PURPOSES : [], parental: f.parental },
      referralCode: f.referral ? f.referralCode.trim() || null : null,
      documents: DOC_KINDS.map((d) => ({ kind: d.kind, label: f.docs[d.kind].label, fileId: f.docs[d.kind].fileId })),
      draft,
    }),
    [f, pct, leadId, existing.data?.leadId],
  );

  const saveable = f.studentName.trim().length >= 2 && phoneOk && (!f.studentEmail.trim() || isValidEmail(f.studentEmail)) && !!f.batchId && !!f.feePlanId && (!f.guardianEmail.trim() || isValidEmail(f.guardianEmail)) && gPhoneOk;
  const editable = !existing.data || existing.data.status === 'draft' || (existing.data.status === 'returned' && existing.data.returnedTo !== 'finance');

  const saveDraft = useCallback(async () => {
    if (!saveable || submitted || !editable) return;
    setSaveState('saving');
    try {
      const body = payload(true);
      const res = admissionId ? await callApi(admissionsContract.update, { params: { id: admissionId }, body }) : await callApi(admissionsContract.submit, { body });
      setAdmissionId(res.id);
      setSaveState('saved');
      void invalidatePrefixes(qc, [['admissions']]);
    } catch {
      setSaveState('error');
    }
  }, [saveable, submitted, editable, payload, admissionId, qc]);

  // Debounced autosave after edits.
  useEffect(() => {
    if (!initKey || !dirty.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveDraft(), 1800);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [f, initKey, saveDraft]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    dirty.current = true;
    setErrors((e) => ({ ...e, [k]: '' }));
    setF((x) => ({ ...x, [k]: v }));
  };

  const stepIssue = (n: number): string | null => {
    if (n === 1) {
      if (f.studentName.trim().length < 2) return 'Enter the student’s full name';
      if (!phoneOk) return 'Enter a valid 10-digit mobile';
      if (f.studentEmail.trim() && !isValidEmail(f.studentEmail)) return 'Enter a valid email';
    }
    if (n === 2) {
      if (!gPhoneOk) return 'Enter the guardian’s 10-digit mobile';
      if (f.guardianEmail.trim() && !isValidEmail(f.guardianEmail)) return 'Enter a valid guardian email';
      if (minor && (!f.guardianName.trim() || !f.guardianPhone.trim())) return 'The student is under 18 — add a guardian with a mobile number';
    }
    if (n === 3 && !f.batchId) return 'Pick a batch';
    if (n === 4) {
      if (!f.feePlanId) return 'Pick a fee plan';
      if (level !== 'none' && !f.discountReason.trim()) return 'Add a reason for the discount request';
    }
    if (n === 5) {
      if (!f.dpdp) return 'Capture DPDP consent before submitting';
      if (minor && !f.parental) return 'The student is under 18 — capture parental consent';
    }
    return null;
  };
  const currentIssue = stepIssue(step);

  const go = (n: number) => {
    if (dirty.current) void saveDraft();
    setStep(n);
  };

  const submit = async () => {
    for (let n = 1; n <= 5; n++) {
      if (stepIssue(n)) {
        setStep(n);
        return;
      }
    }
    if (timer.current) clearTimeout(timer.current);
    setSubmitting(true);
    try {
      const body = payload(false);
      const res = admissionId ? await callApi(admissionsContract.update, { params: { id: admissionId }, body }) : await callApi(admissionsContract.submit, { body });
      setSubmitted(res);
      setAdmissionId(res.id);
      toast(`Submitted for approval · Finance notified`);
      await invalidatePrefixes(qc, [['admissions'], ['sales']]);
    } catch (e) {
      const err = e as ApiError;
      setErrors(err.fields ?? {});
      toast.error(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const upload = async (kind: DocKind, file: File) => {
    setUploading(kind);
    try {
      const r = await uploadFile(file, 'admission_doc');
      const base = DOC_KINDS.find((d) => d.kind === kind)!.label.split(' · ')[0];
      set('docs', { ...f.docs, [kind]: { fileId: r.id, label: `${base} · ${r.filename}`, uploaded: true } });
    } catch (e) {
      toast.error((e as ApiError).message);
    } finally {
      setUploading(null);
    }
  };

  const loading = !opts || (!!leadId && !lead.data && !lead.error) || (!!resumeId && !existing.data && !existing.error);
  const title = f.studentName.trim() || lead.data?.name || 'new applicant';
  const ex = existing.data;

  return (
    <Page label="Sales · New admission">
      <PageHeader
        kicker="Lead → admission · no re-keying"
        title={`${ex && ex.status === 'returned' ? 'Resubmit admission' : 'New admission'} · ${title}`}
        actions={
          submitted ? (
            <Tag variant="accent">Submitted · {submitted.stepLabel}</Tag>
          ) : (
            <Tag variant={saveState === 'error' ? 'ink' : 'neutral'} aria-live="polite">
              {saveState === 'saving' ? 'Saving draft…' : saveState === 'saved' ? 'Draft autosaved' : saveState === 'error' ? 'Draft not saved' : saveable ? 'Draft not saved yet' : 'Draft saves once name, phone, batch & plan are set'}
            </Tag>
          )
        }
      />
      {(lead.error || existing.error || options.error) && (
        <Card>
          <EmptyState title="Could not open this application" body={(lead.error ?? existing.error ?? options.error)!.message} />
        </Card>
      )}
      {ex?.status === 'returned' && ex.returnNote && <Issue kind="needed">Returned to {ex.returnedTo === 'finance' ? 'Finance' : 'Sales'}: {ex.returnNote}</Issue>}
      {ex && !editable && <Issue kind="blocked">This application is {ex.stepLabel.toLowerCase()} — it can no longer be edited here.</Issue>}

      {submitted ? (
        <Card tone="tint" className="gap-2.5">
          <Kicker>Submitted for approval</Kicker>
          <CardTitle>
            {submitted.studentName} · {submitted.batchCode} · {submitted.stepLabel}
          </CardTitle>
          <div className="text-[13px] text-neutral-700">
            {submitted.planLine} · discount {submitted.discountPct}% · Finance verifies the fee terms next{submitted.needsSuperAdmin ? ', then Super Admin approves the discount' : ''}, then the Branch Admin approves. The lead is now in Admission in progress.
          </div>
          <div className="flex gap-2 flex-wrap">
            <Link href="/sales/pipeline">
              <Button variant="secondary">Back to pipeline</Button>
            </Link>
            <Button variant="primary" onClick={() => router.push('/sales/admission')}>
              New admission
            </Button>
          </div>
        </Card>
      ) : loading ? (
        <div className="grid gap-3.5 md:grid-cols-[220px_1fr]">
          <Skeleton className="h-[210px]" />
          <Skeleton className="h-[320px]" />
        </div>
      ) : (
        <div className="grid gap-3.5 items-start md:grid-cols-[220px_minmax(0,1fr)]">
          <nav aria-label="Admission steps" className="grid gap-0.5">
            {STEPS.map((label, i) => {
              const n = i + 1;
              const current = n === step;
              const done = n < step && !stepIssue(n);
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => go(n)}
                  aria-current={current ? 'step' : undefined}
                  className={cn(
                    'flex gap-2.5 items-center px-3 py-2.5 border border-transparent text-[13px] text-left cursor-pointer font-[inherit]',
                    current ? 'bg-accent-100 text-ink border-accent' : done ? 'text-accent-800 hover:bg-ink/4' : 'text-neutral-700 hover:bg-ink/4',
                  )}
                >
                  <span className={cn('w-5 h-5 border border-current grid place-items-center text-[11px] font-semibold', current && 'bg-accent text-white border-accent', done && 'bg-accent-100')}>{done ? '✓' : n}</span>
                  {label}
                </button>
              );
            })}
          </nav>
          <Card pad="xl">
            {step === 1 && (
              <>
                <CardTitle>
                  Student details {lead.data && !ex && <Tag variant="accent" className="ml-2 align-middle">Prefilled from lead</Tag>}
                </CardTitle>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Full name" error={errors.studentName}>
                    <Input value={f.studentName} onChange={(e) => set('studentName', e.target.value)} disabled={!editable} />
                  </Field>
                  <Field label="Phone" error={errors.studentPhone ?? (f.studentPhone && !phoneOk ? 'Enter a valid 10-digit mobile' : null)}>
                    <Input value={f.studentPhone} onChange={(e) => set('studentPhone', e.target.value)} inputMode="tel" placeholder="+91 98470 11223" disabled={!editable} />
                  </Field>
                  <Field label="Email" error={errors.studentEmail ?? (f.studentEmail && !isValidEmail(f.studentEmail) ? 'Enter a valid email' : null)}>
                    <Input value={f.studentEmail} onChange={(e) => set('studentEmail', e.target.value)} type="email" placeholder="student@example.com" disabled={!editable} />
                  </Field>
                  <Field label="Date of birth" hint={age != null ? `${age} years${minor ? ' · under 18 — parental consent needed' : ''}` : undefined}>
                    <Input value={f.studentDob} onChange={(e) => set('studentDob', e.target.value)} type="date" max={today} disabled={!editable} />
                  </Field>
                  <Field label="Address" className="sm:col-span-2">
                    <Input value={f.studentAddress} onChange={(e) => set('studentAddress', e.target.value)} placeholder="Pattom, Trivandrum 695004" disabled={!editable} />
                  </Field>
                </div>
              </>
            )}
            {step === 2 && (
              <>
                <CardTitle>Guardian</CardTitle>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Name">
                    <Input value={f.guardianName} onChange={(e) => set('guardianName', e.target.value)} placeholder="Guardian name" disabled={!editable} />
                  </Field>
                  <Field label="Relationship">
                    <Select value={f.guardianRelationship} onChange={(e) => set('guardianRelationship', e.target.value)} options={['Father', 'Mother', 'Guardian']} disabled={!editable} />
                  </Field>
                  <Field label="Phone (for parent login · OTP)" error={errors.guardianPhone ?? (!gPhoneOk ? 'Enter a valid 10-digit mobile' : null)}>
                    <Input value={f.guardianPhone} onChange={(e) => set('guardianPhone', e.target.value)} placeholder="+91" inputMode="tel" disabled={!editable} />
                  </Field>
                  <Field label="Email">
                    <Input value={f.guardianEmail} onChange={(e) => set('guardianEmail', e.target.value)} placeholder="optional" type="email" disabled={!editable} />
                  </Field>
                </div>
                <div className="text-[13px] text-neutral-700">Parents log in with their own account. One parent can be linked to several children; a second guardian can be added later.</div>
              </>
            )}
            {step === 3 && (
              <>
                <CardTitle>Batch · live seat availability</CardTitle>
                <Field label="Course" className="max-w-[320px]">
                  <Select value={f.courseId} onChange={(e) => set('courseId', e.target.value)} options={(opts?.courses ?? []).map((c) => ({ value: c.id, label: c.name }))} disabled={!editable} />
                </Field>
                <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }} role="radiogroup" aria-label="Batch">
                  {batches.map((b) => {
                    const sel = b.id === f.batchId;
                    const full = b.seatsLeft <= 0;
                    return (
                      <CardButton
                        key={b.id}
                        role="radio"
                        aria-checked={sel}
                        pad="sm"
                        disabled={!editable}
                        onClick={() => {
                          set('batchId', b.id);
                          set('waitlist', full);
                        }}
                        className={cn('gap-1', sel && 'border-accent bg-accent-100', full && !sel && 'opacity-70')}
                      >
                        <div className="flex justify-between gap-2">
                          <b className="font-semibold">
                            {b.code}
                            {opts && b.branchName && batches.some((x) => x.branchId !== b.branchId) ? ` · ${b.branchName}` : ''}
                          </b>
                          {full ? <Tag variant="ink">Waitlist {b.waitlisted}</Tag> : <Tag variant={sel ? 'accent' : 'neutral'}>{b.seatsLeft} seats</Tag>}
                        </div>
                        <div className="text-xs text-neutral-700">{b.line}</div>
                      </CardButton>
                    );
                  })}
                </div>
                {batches.length === 0 && <EmptyState title="No open batches for this course" body="Ask the Branch Admin to open a batch." />}
                {batch && batch.seatsLeft <= 0 && <Issue kind="needed">{batch.code} is full — this application joins the waitlist and is offered a seat when one frees up.</Issue>}
                <div className="text-[13px] text-neutral-700">Seat hold 48 h after booking payment. Capacity is enforced on approval; overflow goes to the waitlist.</div>
              </>
            )}
            {step === 4 && (
              <>
                <CardTitle>Fee plan preview{batch ? ` · ${batch.code}` : ''}</CardTitle>
                <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }} role="radiogroup" aria-label="Fee plan">
                  {plans.map((p) => {
                    const q0 = quoteFee(p.components, 0, p.gstRate, p.earlyPayDiscountPct);
                    const parts = buildSchedule(q0.total, p.schedule, today);
                    const line =
                      p.kind === 'one_time'
                        ? `${formatINR(q0.total)} at admission${p.earlyPayDiscountPct ? ` · ${p.earlyPayDiscountPct}% early-pay discount` : ''}`
                        : p.kind === 'split'
                          ? `${formatINR(parts[0]!.amount)} at admission · ${formatINR(parts[1]?.amount ?? 0)} mid-course`
                          : `${p.schedule.map((s) => s.pct).join(' / ')} · months ${p.schedule.map((s) => Math.round(s.dueOffsetDays / 30.5)).join(', ')}`;
                    const sel = p.id === f.feePlanId;
                    return (
                      <CardButton key={p.id} role="radio" aria-checked={sel} pad="sm" disabled={!editable} onClick={() => set('feePlanId', p.id)} className={cn('gap-1', sel && 'border-accent bg-accent-100')}>
                        <b className="font-semibold">{p.name}</b>
                        <div className="text-xs text-neutral-700">{line}</div>
                      </CardButton>
                    );
                  })}
                </div>
                {plan && quote && (
                  <Table>
                    <tbody>
                      {plan.components.map((c) => (
                        <tr key={c.name}>
                          <TD>{c.name}</TD>
                          <TD className="text-right tabular">{formatINR(c.amount)}</TD>
                        </tr>
                      ))}
                      <tr>
                        <TD>
                          <div className="flex items-center gap-2 flex-wrap">
                            Discount request
                            <span className="inline-flex items-center gap-1">
                              <Input
                                aria-label="Discount percent"
                                value={f.discountPct}
                                onChange={(e) => set('discountPct', e.target.value.replace(/[^\d.]/g, ''))}
                                className="w-[70px] min-h-7 py-0.5"
                                inputMode="decimal"
                                disabled={!editable}
                              />
                              %
                            </span>
                            {level === 'finance' && <Tag variant="neutral">Needs Finance approval (&gt;{opts?.thresholds.financePct}%)</Tag>}
                            {level === 'super_admin' && <Tag variant="ink">Needs Super Admin approval (&gt;{opts?.thresholds.superAdminPct}%)</Tag>}
                          </div>
                        </TD>
                        <TD className="text-right tabular">{quote.discount ? `− ${formatINR(quote.discount)}` : '—'}</TD>
                      </tr>
                      {quote.earlyPayDiscount > 0 && (
                        <tr>
                          <TD>Early-pay discount {plan.earlyPayDiscountPct}%</TD>
                          <TD className="text-right tabular">− {formatINR(quote.earlyPayDiscount)}</TD>
                        </tr>
                      )}
                      <tr>
                        <TD>GST {quote.gstRate}%</TD>
                        <TD className="text-right tabular">{formatINR(quote.gst)}</TD>
                      </tr>
                      <tr>
                        <TD className="font-semibold">Total</TD>
                        <TD className="text-right font-semibold tabular">{formatINR(quote.total)}</TD>
                      </tr>
                    </tbody>
                  </Table>
                )}
                {level !== 'none' && (
                  <Field label="Reason for the discount" error={errors.discountReason}>
                    <Input value={f.discountReason} onChange={(e) => set('discountReason', e.target.value)} placeholder="Sibling of alumnus + merit scholarship" disabled={!editable} />
                  </Field>
                )}
              </>
            )}
            {step === 5 && (
              <>
                <CardTitle>Documents &amp; consent</CardTitle>
                <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
                  {DOC_KINDS.map((d) => {
                    const doc = f.docs[d.kind];
                    return (
                      <div key={d.kind} className="relative p-3 border border-dashed border-divider text-center text-xs grid gap-1.5 justify-items-center">
                        <span className="corner tl" aria-hidden />
                        <span className="corner tr" aria-hidden />
                        <span className="corner bl" aria-hidden />
                        <span className="corner br" aria-hidden />
                        <Tag variant={doc.uploaded ? 'accent' : 'neutral'}>{doc.uploaded ? 'Uploaded' : 'Missing'}</Tag>
                        <div className="break-all">{doc.uploaded ? doc.label : d.label}</div>
                        {editable && (
                          <Button size="sm" variant="secondary" loading={uploading === d.kind} onClick={() => fileInputs.current[d.kind]?.click()}>
                            {doc.uploaded ? 'Replace' : 'Upload'}
                          </Button>
                        )}
                        <input
                          ref={(el) => {
                            fileInputs.current[d.kind] = el;
                          }}
                          type="file"
                          accept="application/pdf,image/png,image/jpeg"
                          className="sr-only"
                          aria-label={`Upload ${d.label}`}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) void upload(d.kind, file);
                            e.target.value = '';
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="text-xs text-neutral-600">Missing documents can follow — Finance checks them when verifying fee terms.</div>
                <Checkbox
                  align="start"
                  checked={f.dpdp}
                  onChange={(v) => set('dpdp', v)}
                  disabled={!editable}
                  label="DPDP consent — purposes listed: academic records, fee communication, WhatsApp reminders. Parental consent captured for under-18 learners."
                />
                {minor && <Checkbox checked={f.parental} onChange={(v) => set('parental', v)} disabled={!editable} label={`Parental consent captured (${f.studentName.split(' ')[0] || 'the student'} is ${age})`} />}
                <Checkbox checked={f.referral} onChange={(v) => set('referral', v)} disabled={!editable} label="Referral code (alumni programme)" />
                {f.referral && (
                  <Field label="Referral code" className="max-w-[260px]">
                    <Input value={f.referralCode} onChange={(e) => set('referralCode', e.target.value.toUpperCase())} placeholder="ALUM-2026-0142" disabled={!editable} />
                  </Field>
                )}
              </>
            )}
            {currentIssue && step !== 5 && <Issue kind="needed">{currentIssue}</Issue>}
            {step === 5 && currentIssue && <Issue kind="needed">{currentIssue}</Issue>}
            <div className="flex justify-between border-t border-divider pt-3 gap-2">
              <Button variant="secondary" onClick={() => go(Math.max(1, step - 1))} disabled={step === 1}>
                Back
              </Button>
              {step === 5 ? (
                <Button variant="primary" blueprint onClick={submit} loading={submitting} disabled={!editable || !!stepIssue(5)}>
                  Submit for approval
                </Button>
              ) : (
                <Button variant="primary" onClick={() => go(step + 1)} disabled={!!currentIssue}>
                  Continue
                </Button>
              )}
            </div>
          </Card>
        </div>
      )}
      <MyApplications />
    </Page>
  );
}
