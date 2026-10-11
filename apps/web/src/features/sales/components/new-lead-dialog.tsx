'use client';

import { salesContract, type LeadDetail } from '@exatech/contracts';
import { isValidEmail, normalizePhone } from '@exatech/domain';
import { Button, Dialog, Field, Input, Issue, Select } from '@exatech/ui';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useBranch } from '@/components/me-context';
import type { ApiError } from '@/lib/api';
import { useApi, useApiMutation } from '@/lib/hooks';
import { FORM_SOURCES, useReference } from '../lib';

interface Form {
  name: string;
  phone: string;
  email: string;
  courseId: string;
  source: string;
  campaign: string;
  preferredBranchId: string;
}

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * New lead: validates name + 10-digit phone, dedupes on phone/email against
 * leads and students, and previews the assignment rule live.
 */
export function NewLeadDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated?: (lead: LeadDetail) => void }) {
  const ref = useReference();
  const { selected, label: branchLabel } = useBranch();
  const blank = useMemo<Form>(() => ({ name: '', phone: '', email: '', courseId: '', source: 'Walk-in', campaign: '', preferredBranchId: selected?.id ?? '' }), [selected?.id]);
  const [f, setF] = useState<Form>(blank);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      setF(blank);
      setTouched({});
      setServerErrors({});
    }
  }, [open, blank]);

  const courses = ref.data?.courses ?? [];
  const branches = (ref.data?.branches ?? []).filter((b) => b.status !== 'archived');
  useEffect(() => {
    if (open && !f.courseId && courses[0]) setF((x) => ({ ...x, courseId: courses.find((c) => c.code === 'DM')?.id ?? courses[0]!.id }));
  }, [open, courses, f.courseId]);

  const phoneOk = normalizePhone(f.phone) !== null;
  const emailOk = !f.email.trim() || isValidEmail(f.email);
  const check = useDebounced({ phone: phoneOk ? f.phone : '', email: emailOk ? f.email.trim() : '', courseId: f.courseId, source: f.source, preferredBranchId: f.preferredBranchId });
  const preview = useApi(
    salesContract.checkLead,
    {
      query: {
        ...(check.phone ? { phone: check.phone } : {}),
        ...(check.email ? { email: check.email } : {}),
        ...(check.courseId ? { courseId: check.courseId } : {}),
        ...(check.preferredBranchId ? { preferredBranchId: check.preferredBranchId } : {}),
        source: check.source,
      },
    },
    { enabled: open, placeholderData: (prev) => prev },
  );
  const dup = preview.data?.duplicate ?? null;

  const create = useApiMutation(salesContract.createLead, {
    invalidate: [['sales']],
    success: (d) => `Lead created · assigned to ${d.ownerName}`,
    toastError: false,
    onSuccess: (d) => {
      onOpenChange(false);
      onCreated?.(d);
    },
    onError: (e: ApiError) => setServerErrors(e.fields ?? { _: e.message }),
  });

  const errors = {
    name: touched.name && f.name.trim().length < 2 ? 'Enter the full name' : (serverErrors.name ?? null),
    phone: touched.phone && !phoneOk ? 'Enter a valid 10-digit mobile' : (serverErrors.phone && serverErrors.phone !== 'Already a lead' && serverErrors.phone !== 'Already an enrolled student' ? serverErrors.phone : null),
    email: touched.email && !emailOk ? 'Enter a valid email' : (serverErrors.email ?? null),
  };
  const set = (k: keyof Form) => (e: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    setServerErrors({});
  };

  const submit = () => {
    setTouched({ name: true, phone: true, email: true });
    if (f.name.trim().length < 2 || !phoneOk || !emailOk || dup) return;
    create.mutate({
      body: {
        name: f.name.trim(),
        phone: f.phone,
        email: f.email.trim() || null,
        courseId: f.courseId || null,
        source: f.source,
        campaign: f.campaign.trim() || null,
        preferredBranchId: f.preferredBranchId || null,
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      kicker={`Sales · ${branchLabel}`}
      title="New lead"
      width={560}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!!dup}>
            Create lead
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <Field label="Full name" error={errors.name}>
          <Input value={f.name} onChange={set('name')} onBlur={() => setTouched((t) => ({ ...t, name: true }))} placeholder="Anu Joseph" autoFocus invalid={!!errors.name} />
        </Field>
        <Field label="Phone (E.164 validated)" error={errors.phone}>
          <Input value={f.phone} onChange={set('phone')} onBlur={() => setTouched((t) => ({ ...t, phone: true }))} placeholder="9847011223" inputMode="tel" invalid={!!errors.phone} />
        </Field>
        <Field label="Email (optional)" error={errors.email}>
          <Input value={f.email} onChange={set('email')} onBlur={() => setTouched((t) => ({ ...t, email: true }))} placeholder="anu.j@gmail.com" type="email" invalid={!!errors.email} />
        </Field>
        <Field label="Course interest">
          <Select value={f.courseId} onChange={set('courseId')} options={courses.map((c) => ({ value: c.id, label: c.name }))} />
        </Field>
        <Field label="Source">
          <Select value={f.source} onChange={set('source')} options={[...FORM_SOURCES]} />
        </Field>
        <Field label="Campaign (optional)">
          <Input value={f.campaign} onChange={set('campaign')} placeholder="IG_Oct_A" />
        </Field>
        <Field label="Preferred branch" className="sm:col-span-2">
          <Select value={f.preferredBranchId} onChange={set('preferredBranchId')} options={[{ value: '', label: 'Same as this branch' }, ...branches.map((b) => ({ value: b.id, label: b.name }))]} />
        </Field>
      </div>
      {dup && (
        <Issue kind="blocked">
          {dup.kind === 'lead' ? (
            <>
              Already a lead — {dup.name} ({dup.line.replace(/^Already a lead · /, '')})
              {dup.canOpen ? (
                <>
                  {' · '}
                  <Link href={`/sales/leads?lead=${dup.id}`} className="text-accent-800 underline underline-offset-[3px]" onClick={() => onOpenChange(false)}>
                    Open existing
                  </Link>
                </>
              ) : (
                ' · ask your manager to reassign it'
              )}
            </>
          ) : (
            <>
              Already an enrolled student — {dup.name}
              {dup.line.includes('·') ? ` · ${dup.line.split('· ').slice(1).join('· ')}` : ''}
            </>
          )}
        </Issue>
      )}
      {serverErrors._ && <Issue kind="blocked">{serverErrors._}</Issue>}
      <div className="text-[13px] text-neutral-700">
        Duplicate check on phone/email · assigned by rule → <b className="font-semibold">{preview.data?.assignee ? `${preview.data.assignee.name}` : preview.isFetching ? '…' : 'you'}</b>
        {preview.data?.assignee && <span className="text-neutral-600"> ({preview.data.assignee.ruleName})</span>} · consent for WhatsApp captured at first contact.
      </div>
    </Dialog>
  );
}
