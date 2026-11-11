'use client';

import { academicsStudentsContract, type AcadStudentDetail, type AcadStudentUpdate } from '@exatech/contracts';
import { Button, Dialog, Field, Input, Issue, Kicker, Select, Textarea, toast } from '@exatech/ui';
import { useEffect, useState } from 'react';
import { useApiMutation } from '@/lib/hooks';
import { apiErrors, type FieldErrors } from '@/features/institution/components/parts';

const national = (e164: string | null | undefined) => (e164 ? (e164.startsWith('+91') ? e164.slice(3) : e164) : '');
const rupees = (paise: number | null | undefined) => (paise == null ? '' : String(paise / 100));

interface Form {
  name: string;
  admissionNo: string;
  phone: string;
  email: string;
  dob: string;
  gender: string;
  address: string;
  gName: string;
  gRelationship: string;
  gPhone: string;
  gEmail: string;
  body: string;
  regNo: string;
  fee: string;
  submittedOn: string;
}

function fromDetail(d: AcadStudentDetail): Form {
  const e = d.edit;
  return {
    name: e.name,
    admissionNo: e.admissionNo ?? '',
    phone: national(e.phone),
    email: e.email ?? '',
    dob: e.dob ?? '',
    gender: e.gender ?? '',
    address: e.address ?? '',
    gName: e.guardian?.name ?? '',
    gRelationship: e.guardian?.relationship ?? '',
    gPhone: national(e.guardian?.phone),
    gEmail: e.guardian?.email ?? '',
    body: e.certification?.body ?? '',
    regNo: e.certification?.regNo ?? '',
    fee: rupees(e.certification?.fee),
    submittedOn: e.certification?.submittedOn ?? '',
  };
}

const BODIES = ['STED', 'BECIL'];

/** Edit a student's details: personal data, parent / guardian, certifying-body registration. Fees and batch are not editable here. */
export function EditStudentDialog({ student, open, onClose }: { student: AcadStudentDetail; open: boolean; onClose: () => void }) {
  const [f, setF] = useState<Form>(() => fromDetail(student));
  const [errors, setErrors] = useState<FieldErrors>({});
  useEffect(() => {
    if (open) {
      setF(fromDetail(student));
      setErrors({});
    }
  }, [open, student]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = useApiMutation(academicsStudentsContract.update, {
    invalidate: [['academics'], ['finance']],
    success: 'Student details saved',
    toastError: false,
    onError: (e) => setErrors(apiErrors(e)),
    onSuccess: (r) => {
      onClose();
      for (const n of r.notices) toast(n, { durationMs: 12_000 });
    },
  });

  const hasGuardian = !!student.edit.guardian;
  const hasEnrollment = !!student.edit.certification;
  const submit = () => {
    const local: FieldErrors = {};
    let feePaise: number | null = null;
    if (f.fee.trim() !== '') {
      const n = Number(f.fee.replace(/[₹,\s]/g, ''));
      if (!Number.isFinite(n) || n < 0) local['certification.fee'] = 'Enter the fee in rupees, e.g. 1000';
      else feePaise = Math.round(n * 100);
    }
    if (Object.keys(local).length) return setErrors(local);
    setErrors({});
    const guardianTouched = hasGuardian || f.gName.trim() !== '' || f.gPhone.trim() !== '' || f.gEmail.trim() !== '';
    const body: AcadStudentUpdate = {
      name: f.name,
      admissionNo: f.admissionNo,
      phone: f.phone,
      email: f.email,
      dob: f.dob || null,
      gender: (f.gender || null) as AcadStudentUpdate['gender'],
      address: f.address,
      guardian: guardianTouched ? { name: f.gName, relationship: f.gRelationship || 'Parent / guardian', phone: f.gPhone, email: f.gEmail } : null,
      certification: hasEnrollment ? { body: f.body, regNo: f.regNo, fee: feePaise, submittedOn: f.submittedOn || null } : null,
    };
    save.mutate({ params: { id: student.id }, body });
  };
  const e = (k: string) => errors[k];
  const topError = errors._ && Object.keys(errors).length === 1 ? errors._ : null;
  const bodyOptions = f.body && !BODIES.includes(f.body) ? [...BODIES, f.body] : BODIES;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={640}
      kicker={`Student · ${student.admissionNo ?? student.branchName}`}
      title={`Edit ${student.name}`}
      description="Fix personal details, the parent / guardian and the STED / BECIL registration. Fees and batch are changed from Finance and Transfer batch."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            Save changes
          </Button>
        </>
      }
    >
      <form
        className="grid gap-3.5"
        onSubmit={(ev) => {
          ev.preventDefault();
          submit();
        }}
        data-testid="edit-student"
      >
        {topError && <Issue kind="blocked">{topError}</Issue>}
        {Object.keys(errors).filter((k) => k !== '_').length > 0 && <Issue kind="blocked">Fix the highlighted fields — nothing was saved.</Issue>}

        <Kicker>Student</Kicker>
        <div className="grid sm:grid-cols-2 gap-2.5">
          <Field label="Full name" error={e('name')}>
            <Input value={f.name} onChange={(ev) => set('name', ev.target.value)} invalid={!!e('name')} />
          </Field>
          <Field label="Admission no." error={e('admissionNo')} hint="Printed on the ID card — change only to fix a typo">
            <Input value={f.admissionNo} onChange={(ev) => set('admissionNo', ev.target.value)} invalid={!!e('admissionNo')} />
          </Field>
          <Field label="Mobile" error={e('phone')} hint="Also the number they sign in with (OTP)">
            <Input inputMode="tel" placeholder="10-digit mobile" value={f.phone} onChange={(ev) => set('phone', ev.target.value)} invalid={!!e('phone')} />
          </Field>
          <Field label="Email" error={e('email')}>
            <Input inputMode="email" placeholder="name@example.com" value={f.email} onChange={(ev) => set('email', ev.target.value)} invalid={!!e('email')} />
          </Field>
          <Field label="Date of birth" error={e('dob')}>
            <Input type="date" max={new Date().toISOString().slice(0, 10)} value={f.dob} onChange={(ev) => set('dob', ev.target.value)} invalid={!!e('dob')} />
          </Field>
          <Field label="Gender" error={e('gender')}>
            <Select
              value={f.gender}
              onChange={(ev) => set('gender', ev.target.value)}
              placeholder="Not set"
              options={[
                { value: 'male', label: 'Male' },
                { value: 'female', label: 'Female' },
                { value: 'other', label: 'Other' },
              ]}
            />
          </Field>
          <Field label="Address" error={e('address')} className="sm:col-span-2">
            <Textarea rows={2} value={f.address} onChange={(ev) => set('address', ev.target.value)} invalid={!!e('address')} />
          </Field>
        </div>

        <Kicker>Parent / guardian</Kicker>
        {student.edit.guardian && student.edit.guardian.otherStudents > 0 && (
          <div className="text-[12px] text-neutral-700 border border-divider bg-accent-100 px-2.5 py-1.5">
            Shared with {student.edit.guardian.otherStudents} other student{student.edit.guardian.otherStudents > 1 ? 's' : ''} — changes here apply to them too.
          </div>
        )}
        <div className="grid sm:grid-cols-2 gap-2.5">
          <Field label="Parent / guardian name" error={e('guardian.name')}>
            <Input value={f.gName} onChange={(ev) => set('gName', ev.target.value)} invalid={!!e('guardian.name')} />
          </Field>
          <Field label="Relationship" error={e('guardian.relationship')}>
            <Input placeholder="Father, Mother, Guardian…" value={f.gRelationship} onChange={(ev) => set('gRelationship', ev.target.value)} invalid={!!e('guardian.relationship')} />
          </Field>
          <Field label="Parent mobile" error={e('guardian.phone')} hint="The parent app signs in with this number — it must be different from the student's">
            <Input inputMode="tel" placeholder="10-digit mobile" value={f.gPhone} onChange={(ev) => set('gPhone', ev.target.value)} invalid={!!e('guardian.phone')} />
          </Field>
          <Field label="Parent email" error={e('guardian.email')}>
            <Input inputMode="email" value={f.gEmail} onChange={(ev) => set('gEmail', ev.target.value)} invalid={!!e('guardian.email')} />
          </Field>
        </div>

        {hasEnrollment && (
          <>
            <Kicker>Certifying body registration</Kicker>
            <div className="grid sm:grid-cols-2 gap-2.5">
              <Field label="Body" error={e('certification.body')}>
                <Select value={f.body} onChange={(ev) => set('body', ev.target.value)} placeholder="Not set" options={bodyOptions} />
              </Field>
              <Field label="Registration no." error={e('certification.regNo')}>
                <Input value={f.regNo} onChange={(ev) => set('regNo', ev.target.value)} invalid={!!e('certification.regNo')} />
              </Field>
              <Field label="Body fee ₹" error={e('certification.fee')} hint="Paid by the institute to STED / BECIL — not billed to the student">
                <Input inputMode="decimal" value={f.fee} onChange={(ev) => set('fee', ev.target.value)} invalid={!!e('certification.fee')} />
              </Field>
              <Field label="Fee submitted on" error={e('certification.submittedOn')}>
                <Input type="date" max={new Date().toISOString().slice(0, 10)} value={f.submittedOn} onChange={(ev) => set('submittedOn', ev.target.value)} invalid={!!e('certification.submittedOn')} />
              </Field>
            </div>
          </>
        )}
      </form>
    </Dialog>
  );
}
