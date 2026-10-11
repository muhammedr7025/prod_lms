'use client';

import { institutionStaffContract, LEAVE_TYPES, type InstStaffDetail } from '@exatech/contracts';
import { isValidPhone, todayIST } from '@exatech/domain';
import { Button, Dialog, EmptyState, Field, Input, Issue, Select, Skeleton, Table, TableScroll, Tag, Textarea, TD, TH } from '@exatech/ui';
import { useEffect, useMemo, useState } from 'react';
import { useMe } from '@/components/me-context';
import { apiErrors, type FieldErrors } from '@/features/institution/components/parts';
import { useApi, useApiMutation } from '@/lib/hooks';
import { MembershipEditor, toDrafts, toInputs, type MembershipDraft } from './membership-editor';

const INVALIDATE = [['institution'], ['reference'], ['academics']] as const;

/* ───────────────────────── Invite staff ───────────────────────── */

export function InviteDialog({ open, onClose, onInvited }: { open: boolean; onClose: () => void; onInvited?: (userId: string) => void }) {
  const me = useMe();
  const options = useApi(institutionStaffContract.options, {}, { enabled: open });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [home, setHome] = useState('');
  const [title, setTitle] = useState('');
  const [memberships, setMemberships] = useState<MembershipDraft[]>([]);
  const [errors, setErrors] = useState<FieldErrors>({});
  useEffect(() => {
    if (!open) return;
    const def = me.branch.selectedId ?? '';
    setName('');
    setEmail('');
    setPhone('');
    setHome(def);
    setTitle('');
    setMemberships([{ key: 1, roleId: '', branchIds: def ? [def] : [] }]);
    setErrors({});
  }, [open, me.branch.selectedId]);
  const invite = useApiMutation(institutionStaffContract.invite, {
    invalidate: INVALIDATE,
    success: (r) => `Invite sent to ${r.name} · email + WhatsApp`,
    toastError: false,
    onError: (e) => setErrors(apiErrors(e)),
    onSuccess: (r) => {
      onClose();
      onInvited?.(r.userId);
    },
  });
  const submit = () => {
    const body = { name, email, phone, homeBranchId: home, title: title.trim() || null, memberships: toInputs(memberships) };
    const e: FieldErrors = {};
    if (!home) e.homeBranchId = 'Choose the home branch';
    if (phone && !isValidPhone(phone)) e.phone = 'Enter a valid 10-digit mobile';
    if (memberships.some((m) => !m.roleId)) e.memberships = 'Choose a role for every membership (or remove the empty row)';
    if (Object.keys(e).length) return setErrors(e);
    setErrors({});
    invite.mutate({ body });
  };
  const membershipError = Object.entries(errors).find(([k]) => k.startsWith('memberships'))?.[1];
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={600}
      kicker="Invite-only · role × scope"
      title="Invite staff"
      description="They get an email and a WhatsApp message with the sign-in link. The account becomes active on first sign-in."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={invite.isPending} onClick={submit}>
            Send invite
          </Button>
        </>
      }
    >
      <div className="grid sm:grid-cols-2 gap-2.5">
        <Field label="Full name" error={errors.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Lekha Thomas" autoFocus />
        </Field>
        <Field label="Title" error={errors.title}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Trainer · Data Analytics" />
        </Field>
        <Field label="Email" error={errors.email}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="lekha@exatech.test" />
        </Field>
        <Field label="Mobile" error={errors.phone}>
          <Input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="98470 12345" />
        </Field>
        <Field label="Home branch" error={errors.homeBranchId}>
          <Select value={home} onChange={(e) => setHome(e.target.value)} placeholder="Choose…" options={(options.data?.branches ?? []).map((b) => ({ value: b.id, label: b.name }))} />
        </Field>
      </div>
      <div className="grid gap-1.5">
        <div className="text-xs text-ink/70">Memberships (role × scope)</div>
        {options.isPending ? <Skeleton className="h-20" /> : <MembershipEditor value={memberships} onChange={setMemberships} roles={options.data?.roles ?? []} branches={options.data?.branches ?? []} error={membershipError} />}
      </div>
      {errors._ && !Object.keys(errors).some((k) => k !== '_') && <Issue>{errors._}</Issue>}
    </Dialog>
  );
}

/* ───────────────────────── Leave calendar ───────────────────────── */

export function LeaveCalendarDialog({ open, onClose, onOpenPerson }: { open: boolean; onClose: () => void; onOpenPerson: (userId: string) => void }) {
  const { data, isPending, error } = useApi(institutionStaffContract.leave, {}, { enabled: open });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} width={760} kicker="Upcoming · across staff" title="Leave calendar" description="Approved leave flags the person’s sessions for a substitute; pending requests are decided in Branch operations.">
      <TableScroll minWidth={620}>
        <Table className="text-[13px]">
          <thead>
            <tr>
              <TH className="first:pl-3">Date</TH>
              <TH>Person</TH>
              <TH>Type</TH>
              <TH>Timetable</TH>
              <TH>Status</TH>
            </tr>
          </thead>
          <tbody>
            {isPending && (
              <tr>
                <TD colSpan={5}>
                  <Skeleton className="h-16" />
                </TD>
              </tr>
            )}
            {data?.map((l) => (
              <tr key={l.id} data-testid="leave-calendar-row">
                <TD className="first:pl-3 whitespace-nowrap">{l.dateLabel}</TD>
                <TD>
                  <button type="button" className="border-0 bg-transparent p-0 font-[inherit] text-accent-800 underline underline-offset-[3px] cursor-pointer text-left" onClick={() => onOpenPerson(l.userId)}>
                    {l.name}
                  </button>
                  {l.reason && <div className="text-[11px] text-neutral-600">{l.reason}</div>}
                </TD>
                <TD>{l.type}</TD>
                <TD className="text-xs">{l.impact}</TD>
                <TD>
                  <Tag variant={l.statusTag}>{l.statusLabel}</Tag>
                </TD>
              </tr>
            ))}
          </tbody>
        </Table>
      </TableScroll>
      {error && <EmptyState title="Could not load leave" body={error.message} />}
      {data && data.length === 0 && <EmptyState title="No upcoming leave" body="Leave requested by teachers or recorded here appears in this calendar." />}
    </Dialog>
  );
}

/* ───────────────────────── Edit memberships ───────────────────────── */

export function EditMembershipsDialog({ person, open, onClose }: { person: InstStaffDetail; open: boolean; onClose: () => void }) {
  const options = useApi(institutionStaffContract.options, {}, { enabled: open });
  const [value, setValue] = useState<MembershipDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setValue(toDrafts(person.memberships));
      setError(null);
    }
  }, [open, person.memberships]);
  const save = useApiMutation(institutionStaffContract.setMemberships, {
    invalidate: person.isSelf ? [['institution'], ['me']] : [['institution']],
    success: `Memberships updated · ${person.name}`,
    toastError: false,
    onError: (e) => setError(e.message),
    onSuccess: onClose,
  });
  // Your own last Super Admin membership cannot go (server enforces it too).
  const ownSuper = person.isSelf && person.memberships.some((m) => m.roleKey === 'superadmin');
  const superRoleId = options.data?.roles.find((r) => r.key === 'superadmin')?.id;
  const removesOwnSuper = ownSuper && !!superRoleId && !value.some((m) => m.roleId === superRoleId);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={600}
      kicker={person.name}
      title="Edit memberships"
      description="A membership is role × scope. Changes apply immediately — the person keeps their session and sees the new access on their next action."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={removesOwnSuper || value.length === 0} loading={save.isPending} onClick={() => save.mutate({ params: { id: person.userId }, body: { memberships: toInputs(value) } })}>
            Save memberships
          </Button>
        </>
      }
    >
      {options.isPending ? <Skeleton className="h-24" /> : <MembershipEditor value={value} onChange={setValue} roles={options.data?.roles ?? []} branches={options.data?.branches ?? []} />}
      {removesOwnSuper && <Issue>You can’t remove your own Super Admin membership — ask another Super Admin.</Issue>}
      {value.length === 0 && <Issue kind="needed">Keep at least one membership — to remove all access, deactivate the account instead.</Issue>}
      {error && <Issue>{error}</Issue>}
    </Dialog>
  );
}

/* ───────────────────────── Assign to batch ───────────────────────── */

export function AssignDialog({ person, open, onClose }: { person: InstStaffDetail; open: boolean; onClose: () => void }) {
  const [batchId, setBatchId] = useState('');
  const [subject, setSubject] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setBatchId('');
      setSubject('');
      setError(null);
    }
  }, [open]);
  const teaching = useMemo(() => new Set(person.teaching.map((t) => t.batchId)), [person.teaching]);
  const batch = person.assignOptions.find((b) => b.batchId === batchId);
  const assign = useApiMutation(institutionStaffContract.assign, {
    invalidate: [...INVALIDATE, ['teaching']],
    success: () => `${person.name} → ${batch?.code ?? 'batch'} · ${subject}`,
    toastError: false,
    onError: (e) => setError(e.message),
    onSuccess: onClose,
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={520}
      kicker={person.name}
      title="Assign to batch"
      description="One subject per batch. Sessions follow the batch timetable — add or swap them in Timetable."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!batchId || !subject} loading={assign.isPending} onClick={() => assign.mutate({ params: { id: person.userId }, body: { batchId, subjectName: subject } })}>
            Assign
          </Button>
        </>
      }
    >
      <Field label="Batch" hint={person.assignOptions.length ? 'Live batches in the branches of their Teacher membership' : undefined}>
        <Select
          value={batchId}
          onChange={(e) => {
            setBatchId(e.target.value);
            setSubject('');
            setError(null);
          }}
          placeholder="Choose…"
          options={person.assignOptions.map((b) => ({ value: b.batchId, label: `${b.code} · ${b.courseName} · ${b.branchCode}${teaching.has(b.batchId) ? ' · already teaches here' : ''}`, disabled: teaching.has(b.batchId) }))}
        />
      </Field>
      <Field label="Subject (from the course syllabus)">
        <Select
          value={subject}
          disabled={!batch}
          onChange={(e) => setSubject(e.target.value)}
          placeholder={batch ? 'Choose…' : 'Pick a batch first'}
          options={(batch?.subjects ?? []).map((s) => {
            const taken = batch?.taken.find((t) => t.subject === s);
            return { value: s, label: taken ? `${s} · taught by ${taken.teacherName}` : s, disabled: !!taken };
          })}
        />
      </Field>
      {person.assignOptions.length === 0 && <Issue kind="needed">No live batches in their teaching branches — add a Teacher membership (with branches) first.</Issue>}
      {error && <Issue>{error}</Issue>}
    </Dialog>
  );
}

/* ───────────────────────── Record leave ───────────────────────── */

const TYPE_LABEL: Record<(typeof LEAVE_TYPES)[number], string> = { casual: 'Casual', sick: 'Sick', earned: 'Earned', on_duty: 'On duty' };

export function RecordLeaveDialog({ person, open, onClose }: { person: InstStaffDetail; open: boolean; onClose: () => void }) {
  const [date, setDate] = useState(todayIST());
  const [type, setType] = useState<(typeof LEAVE_TYPES)[number]>('casual');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  useEffect(() => {
    if (open) {
      setDate(todayIST());
      setType('casual');
      setReason('');
      setErrors({});
    }
  }, [open]);
  const record = useApiMutation(institutionStaffContract.recordLeave, {
    invalidate: [...INVALIDATE, ['teaching']],
    success: (r) => `Leave recorded${r.flagged ? ` · ${r.flagged} session${r.flagged === 1 ? '' : 's'} flagged for a substitute` : ''}`,
    toastError: false,
    onError: (e) => setErrors(apiErrors(e)),
    onSuccess: onClose,
  });
  const submit = () => {
    if (reason.trim().length < 2) return setErrors({ reason: 'Add a reason' });
    record.mutate({ params: { id: person.userId }, body: { date, type, reason: reason.trim() } });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={460}
      kicker={person.name}
      title="Record leave"
      description="Recorded as approved on their behalf. Their sessions that day are flagged “leave · substitute?” for the branch to cover."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={record.isPending} onClick={submit}>
            Record leave
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Date" error={errors.date}>
          <Input type="date" min={todayIST()} value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value as (typeof LEAVE_TYPES)[number])} options={LEAVE_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))} />
        </Field>
      </div>
      <Field label="Reason" error={errors.reason}>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Fever — called the branch at 8 am" className="min-h-[70px]" />
      </Field>
      {errors._ && !errors.reason && !errors.date && <Issue>{errors._}</Issue>}
    </Dialog>
  );
}

/* ───────────────────────── Deactivate / reactivate ───────────────────────── */

export function StatusDialog({ person, open, onClose }: { person: InstStaffDetail; open: boolean; onClose: () => void }) {
  const deactivating = person.userStatus !== 'deactivated';
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
    }
  }, [open]);
  const run = useApiMutation(institutionStaffContract.setStatus, {
    invalidate: INVALIDATE,
    success: (r) => (deactivating ? `${person.name} deactivated · signed out of ${r.signedOut} session${r.signedOut === 1 ? '' : 's'}` : `${person.name} reactivated`),
    toastError: false,
    onError: (e) => setError(e.message),
    onSuccess: onClose,
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={460}
      kicker={person.name}
      title={deactivating ? 'Deactivate account' : 'Reactivate account'}
      description={
        deactivating
          ? 'They are signed out everywhere at once and can’t sign in again. Memberships are kept so you can reactivate later; their upcoming sessions stay on the timetable and need a substitute.'
          : 'They can sign in again with the same memberships.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={deactivating ? 'ink' : 'primary'} disabled={person.isSelf && deactivating} loading={run.isPending} onClick={() => run.mutate({ params: { id: person.userId }, body: { status: deactivating ? 'deactivated' : 'active', reason: reason.trim() || undefined } })}>
            {deactivating ? 'Deactivate & sign out' : 'Reactivate'}
          </Button>
        </>
      }
    >
      <Field label="Reason (written to the audit log)">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={deactivating ? 'e.g. Left the institution' : 'e.g. Rejoined'} />
      </Field>
      {person.isSelf && deactivating && <Issue>You can’t deactivate your own account.</Issue>}
      {error && <Issue>{error}</Issue>}
    </Dialog>
  );
}
