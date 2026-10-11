'use client';

import { institutionBranchesContract, referenceContract, ROOM_KINDS, zBranchCreate, zBranchUpdate, zRoomInput, type InstBranchCard, type InstRoom } from '@exatech/contracts';
import { todayIST } from '@exatech/domain';
import { Button, Checkbox, Dialog, EmptyState, Field, Input, Issue, Select, Skeleton, Table, TableScroll, Tag, TD, TH, cn } from '@exatech/ui';
import { useEffect, useMemo, useState } from 'react';
import { apiErrors, rupeesToPaise, zodErrors, type FieldErrors } from '@/features/institution';
import { useApi, useApiMutation } from '@/lib/hooks';

const KIND_LABEL: Record<(typeof ROOM_KINDS)[number], string> = { room: 'Room', lab: 'Lab', hall: 'Hall' };
const KIND_OPTIONS = ROOM_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }));

interface RoomDraft {
  key: number;
  name: string;
  capacity: string;
  kind: (typeof ROOM_KINDS)[number];
}

/* ───────────────────────── Add / edit branch ───────────────────────── */

interface BranchForm {
  code: string;
  name: string;
  address: string;
  city: string;
  phone: string;
  email: string;
  gstin: string;
  gstShared: boolean;
  openedOn: string;
  target: string;
  managerUserId: string;
  status: 'active' | 'paused' | 'archived';
  statusNote: string;
}

const emptyForm = (): BranchForm => ({ code: '', name: '', address: '', city: '', phone: '', email: '', gstin: '', gstShared: true, openedOn: todayIST(), target: '', managerUserId: '', status: 'active', statusNote: '' });

const fromCard = (b: InstBranchCard): BranchForm => ({
  code: b.code,
  name: b.name,
  address: b.address ?? '',
  city: b.city ?? '',
  phone: b.phone ?? '',
  email: b.email ?? '',
  gstin: b.gstin ?? '',
  gstShared: !b.gstin,
  openedOn: b.openedOn ?? todayIST(),
  target: String(Math.round(b.monthlyTarget / 100)),
  managerUserId: b.managerUserId ?? '',
  status: b.status,
  statusNote: b.statusNote ?? '',
});

/** Add branch (with rooms) or edit an existing one. */
export function BranchFormDialog({ open, onClose, branch, onCreated }: { open: boolean; onClose: () => void; branch?: InstBranchCard | null; onCreated?: (b: InstBranchCard) => void }) {
  const editing = !!branch;
  const ref = useApi(referenceContract.get, {}, { enabled: open });
  const [f, setF] = useState<BranchForm>(emptyForm);
  const [rooms, setRooms] = useState<RoomDraft[]>([]);
  const [errors, setErrors] = useState<FieldErrors>({});
  useEffect(() => {
    if (!open) return;
    setF(branch ? fromCard(branch) : emptyForm());
    setRooms(branch ? [] : [{ key: 1, name: 'Room 1', capacity: '30', kind: 'room' }]);
    setErrors({});
  }, [open, branch]);
  const set = <K extends keyof BranchForm>(k: K, v: BranchForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const onError = (e: Parameters<typeof apiErrors>[0]) => setErrors(apiErrors(e));
  const create = useApiMutation(institutionBranchesContract.create, {
    invalidate: [['institution'], ['me'], ['reference']],
    success: (b) => `${b.code} · ${b.name} added`,
    toastError: false,
    onError,
    onSuccess: (b) => {
      onClose();
      onCreated?.(b);
    },
  });
  const update = useApiMutation(institutionBranchesContract.update, { invalidate: [['institution'], ['me'], ['reference']], success: (b) => `${b.name} updated`, toastError: false, onError, onSuccess: onClose });
  const managers = useMemo(() => (ref.data?.staff ?? []).filter((s) => !s.roleKeys.every((r) => r === 'student' || r === 'parent')), [ref.data]);

  const submit = () => {
    const target = rupeesToPaise(f.target);
    const base = {
      name: f.name,
      address: f.address,
      city: f.city,
      phone: f.phone.trim() || null,
      email: f.email.trim() || null,
      gstin: f.gstShared ? null : f.gstin,
      openedOn: f.openedOn,
      monthlyTarget: target ?? -1,
      managerUserId: f.managerUserId || null,
    };
    if (target === null) {
      setErrors({ monthlyTarget: 'Enter the monthly collection target in rupees' });
      return;
    }
    if (editing) {
      const body = { ...base, status: f.status, statusNote: f.statusNote.trim() || null };
      const r = zBranchUpdate.safeParse(body);
      if (!r.success) return setErrors(zodErrors(r.error));
      setErrors({});
      update.mutate({ params: { id: branch!.id }, body });
    } else {
      const body = { ...base, code: f.code, rooms: rooms.map((x) => ({ name: x.name, capacity: Number(x.capacity), kind: x.kind })) };
      const r = zBranchCreate.safeParse(body);
      if (!r.success) return setErrors(zodErrors(r.error));
      setErrors({});
      create.mutate({ body });
    }
  };
  const roomErr = Object.entries(errors).find(([k]) => k.startsWith('rooms'))?.[1];

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={640}
      kicker={editing ? `${branch!.code} · branch` : 'Institution · branches'}
      title={editing ? `Edit ${branch!.name}` : 'Add branch'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending || update.isPending} onClick={submit}>
            {editing ? 'Save branch' : 'Add branch'}
          </Button>
        </>
      }
    >
      <div className="grid sm:grid-cols-[120px_1fr] gap-2.5">
        <Field label="Code" error={errors.code} hint={editing ? 'Codes never change' : '2–5 letters'}>
          <Input value={f.code} disabled={editing} onChange={(e) => set('code', e.target.value.toUpperCase())} placeholder="KTM" maxLength={5} />
        </Field>
        <Field label="Branch name" error={errors.name}>
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Kottayam" />
        </Field>
      </div>
      <div className="grid sm:grid-cols-[1fr_180px] gap-2.5">
        <Field label="Address" error={errors.address}>
          <Input value={f.address} onChange={(e) => set('address', e.target.value)} placeholder="Building, street, area" />
        </Field>
        <Field label="City" error={errors.city}>
          <Input value={f.city} onChange={(e) => set('city', e.target.value)} />
        </Field>
      </div>
      <div className="grid sm:grid-cols-2 gap-2.5">
        <Field label="Phone" error={errors.phone}>
          <Input value={f.phone} onChange={(e) => set('phone', e.target.value)} placeholder="0481 2500 440" />
        </Field>
        <Field label="Email" error={errors.email}>
          <Input value={f.email} type="email" onChange={(e) => set('email', e.target.value)} placeholder="ktm@exatech.test" />
        </Field>
      </div>
      <div className="grid gap-1.5">
        <Field label="GSTIN" error={errors.gstin} hint={f.gstShared ? 'Invoices use the institution’s GSTIN' : '15 characters, e.g. 32AABCE1234F1Z5'}>
          <Input value={f.gstShared ? '' : f.gstin} disabled={f.gstShared} onChange={(e) => set('gstin', e.target.value.toUpperCase())} placeholder={f.gstShared ? 'Shared with institution' : '32AABCE1234F1Z5'} maxLength={15} />
        </Field>
        <Checkbox checked={f.gstShared} onChange={(v) => set('gstShared', v)} label="GST registration shared with the institution" />
      </div>
      <div className="grid sm:grid-cols-3 gap-2.5">
        <Field label="Opened" error={errors.openedOn}>
          <Input type="date" value={f.openedOn} onChange={(e) => set('openedOn', e.target.value)} />
        </Field>
        <Field label="Monthly collection target ₹" error={errors.monthlyTarget}>
          <Input inputMode="numeric" value={f.target} onChange={(e) => set('target', e.target.value)} placeholder="7,20,000" />
        </Field>
        <Field label="Manager" error={errors.managerUserId}>
          <Select value={f.managerUserId} onChange={(e) => set('managerUserId', e.target.value)} placeholder="Not set" options={managers.map((m) => ({ value: m.id, label: m.name }))} />
        </Field>
      </div>
      {editing && (
        <div className="grid sm:grid-cols-2 gap-2.5">
          <Field label="Status" error={errors.status}>
            <Select
              value={f.status}
              onChange={(e) => set('status', e.target.value as BranchForm['status'])}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'paused', label: 'Paused (no new admissions)' },
                { value: 'archived', label: 'Archived' },
              ]}
            />
          </Field>
          <Field label="Status note (optional)" error={errors.statusNote}>
            <Input value={f.statusNote} onChange={(e) => set('statusNote', e.target.value)} placeholder="e.g. Opened Aug 2026" />
          </Field>
        </div>
      )}
      {!editing && (
        <div className="grid gap-2 border-t border-divider pt-2.5">
          <div className="flex justify-between items-center">
            <div className="text-xs text-ink/70">Rooms & capacity</div>
            <Button variant="ghost" size="sm" onClick={() => setRooms((r) => [...r, { key: Date.now(), name: `Room ${r.length + 1}`, capacity: '24', kind: 'room' }])}>
              Add room
            </Button>
          </div>
          {rooms.length === 0 && <div className="text-[13px] text-neutral-600">No rooms yet — you can add them later from the branch panel.</div>}
          {rooms.length > 0 && (
            <div className="grid grid-cols-[1fr_90px_100px_34px] gap-2 text-[11px] text-neutral-600" aria-hidden>
              <span>Room</span>
              <span>Seats</span>
              <span>Kind</span>
              <span />
            </div>
          )}
          {rooms.map((r, i) => (
            <div key={r.key} className="grid grid-cols-[1fr_90px_100px_auto] gap-2 items-center">
              <Input aria-label={`Room ${i + 1} name`} value={r.name} onChange={(e) => setRooms((list) => list.map((x) => (x.key === r.key ? { ...x, name: e.target.value } : x)))} />
              <Input aria-label={`Room ${i + 1} capacity`} inputMode="numeric" value={r.capacity} onChange={(e) => setRooms((list) => list.map((x) => (x.key === r.key ? { ...x, capacity: e.target.value } : x)))} />
              <Select aria-label={`Room ${i + 1} kind`} value={r.kind} onChange={(e) => setRooms((list) => list.map((x) => (x.key === r.key ? { ...x, kind: e.target.value as RoomDraft['kind'] } : x)))} options={KIND_OPTIONS} />
              <Button variant="secondary" size="iconSm" aria-label={`Remove room ${i + 1}`} onClick={() => setRooms((list) => list.filter((x) => x.key !== r.key))}>
                ×
              </Button>
            </div>
          ))}
          {roomErr && <Issue>{roomErr}</Issue>}
        </div>
      )}
      {errors._ && !Object.keys(errors).some((k) => k !== '_') && <Issue>{errors._}</Issue>}
    </Dialog>
  );
}

/* ───────────────────────── Rooms & capacity ───────────────────────── */

function RoomRow({ room, canManage }: { room: InstRoom; canManage: boolean }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(room.name);
  const [capacity, setCapacity] = useState(String(room.capacity));
  const [kind, setKind] = useState(room.kind);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const save = useApiMutation(institutionBranchesContract.updateRoom, {
    invalidate: [['institution'], ['reference']],
    success: (r) => `${r.name} · ${r.active ? 'saved' : 'deactivated'}`,
    toastError: false,
    onSuccess: () => {
      setEditing(false);
      setBlocked(null);
      setErr(null);
    },
    onError: (e) => (e.code === 'ROOM_IN_USE' ? setBlocked(e.message) : setErr(e.message)),
  });
  const submit = (active: boolean, confirm = false) => {
    const body = { name, capacity: Number(capacity), kind, active, confirm };
    const r = zRoomInput.safeParse(body);
    if (!r.success) return setErr(r.error.issues[0]?.message ?? 'Check the room');
    setErr(null);
    save.mutate({ params: { id: room.id }, body });
  };
  return (
    <>
      <tr className={cn(!room.active && 'opacity-60')} data-testid="room-row">
        <TD className="first:pl-3.5 font-medium">{editing ? <Input aria-label="Room name" value={name} onChange={(e) => setName(e.target.value)} className="min-w-[120px]" /> : room.name}</TD>
        <TD className="tabular">{editing ? <Input aria-label="Room capacity" inputMode="numeric" value={capacity} onChange={(e) => setCapacity(e.target.value)} className="w-20" /> : room.capacity}</TD>
        <TD>{editing ? <Select aria-label="Room kind" value={kind} onChange={(e) => setKind(e.target.value as InstRoom['kind'])} options={KIND_OPTIONS} /> : KIND_LABEL[room.kind]}</TD>
        <TD className="text-neutral-600 tabular">{room.upcomingSessions}</TD>
        <TD>
          <Tag variant={room.active ? 'accent' : 'plain'}>{room.active ? 'Active' : 'Inactive'}</Tag>
        </TD>
        <TD className="text-right whitespace-nowrap">
          {canManage &&
            (editing ? (
              <span className="inline-flex gap-1">
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button variant="primary" size="sm" loading={save.isPending} onClick={() => submit(room.active)}>
                  Save
                </Button>
              </span>
            ) : (
              <span className="inline-flex gap-1">
                <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button variant="ghost" size="sm" loading={save.isPending} onClick={() => submit(!room.active)}>
                  {room.active ? 'Deactivate' : 'Reactivate'}
                </Button>
              </span>
            ))}
        </TD>
      </tr>
      {(blocked || err) && (
        <tr>
          <TD colSpan={6} className="first:pl-3.5">
            <div className="grid gap-2 py-1">
              <Issue>{blocked ?? err}</Issue>
              {blocked && (
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setBlocked(null)}>
                    Keep active
                  </Button>
                  <Button variant="ink" size="sm" loading={save.isPending} onClick={() => submit(false, true)}>
                    Deactivate anyway
                  </Button>
                </div>
              )}
            </div>
          </TD>
        </tr>
      )}
    </>
  );
}

export function RoomsDialog({ branchId, branchName, open, onClose }: { branchId: string; branchName: string; open: boolean; onClose: () => void }) {
  const detail = useApi(institutionBranchesContract.get, { params: { id: branchId } }, { enabled: open });
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('');
  const [kind, setKind] = useState<InstRoom['kind']>('room');
  const [err, setErr] = useState<FieldErrors>({});
  useEffect(() => {
    if (open) {
      setName('');
      setCapacity('');
      setErr({});
    }
  }, [open]);
  const add = useApiMutation(institutionBranchesContract.addRoom, {
    invalidate: [['institution'], ['reference']],
    success: (r) => `${r.name} added · ${r.capacity} seats`,
    toastError: false,
    onError: (e) => setErr(apiErrors(e)),
    onSuccess: () => {
      setName('');
      setCapacity('');
      setErr({});
    },
  });
  const submit = () => {
    const body = { name, capacity: Number(capacity), kind };
    const r = zRoomInput.safeParse({ ...body, capacity: capacity.trim() === '' ? undefined : Number(capacity) });
    if (!r.success) return setErr(zodErrors(r.error));
    add.mutate({ params: { id: branchId }, body });
  };
  const rooms = detail.data?.rooms ?? [];
  const canManage = detail.data?.canManage ?? false;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} width={720} kicker={branchName} title="Rooms & capacity" description="Capacity is checked when sessions are timetabled. Deactivated rooms stay on past sessions.">
      <TableScroll minWidth={560}>
        <Table className="text-[13px]">
          <thead>
            <tr>
              <TH className="first:pl-3.5">Room</TH>
              <TH>Capacity</TH>
              <TH>Kind</TH>
              <TH>Upcoming sessions</TH>
              <TH>Status</TH>
              <TH />
            </tr>
          </thead>
          <tbody>
            {detail.isPending && (
              <tr>
                <TD colSpan={6}>
                  <Skeleton className="h-16" />
                </TD>
              </tr>
            )}
            {rooms.map((r) => (
              <RoomRow key={`${r.id}:${r.name}:${r.capacity}:${r.active}`} room={r} canManage={canManage} />
            ))}
          </tbody>
        </Table>
      </TableScroll>
      {detail.data && rooms.length === 0 && <EmptyState className="py-4" title="No rooms yet" body="Add the first room below." />}
      {canManage && (
        <div className="grid gap-2 border-t border-divider pt-2.5">
          <div className="text-xs text-ink/70">Add a room</div>
          <div className="grid grid-cols-[1fr_100px_110px_auto] gap-2 items-start">
            <Field label="Name" error={err.name}>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Room 5" />
            </Field>
            <Field label="Capacity" error={err.capacity}>
              <Input inputMode="numeric" value={capacity} onChange={(e) => setCapacity(e.target.value)} placeholder="24" />
            </Field>
            <Field label="Kind">
              <Select value={kind} onChange={(e) => setKind(e.target.value as InstRoom['kind'])} options={KIND_OPTIONS} />
            </Field>
            <Button variant="primary" className="mt-[21px]" loading={add.isPending} onClick={submit}>
              Add room
            </Button>
          </div>
          {err._ && !err.name && !err.capacity && <Issue>{err._}</Issue>}
        </div>
      )}
    </Dialog>
  );
}

/* ───────────────────────── Holiday calendar ───────────────────────── */

export function HolidaysDialog({ open, onClose, branchId }: { open: boolean; onClose: () => void; branchId?: string | null }) {
  const list = useApi(institutionBranchesContract.holidays, {}, { enabled: open });
  const branches = useApi(institutionBranchesContract.list, {}, { enabled: open });
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<string>(branchId ?? '');
  const [err, setErr] = useState<FieldErrors>({});
  useEffect(() => {
    if (open) {
      setDate('');
      setName('');
      setScope(branchId ?? '');
      setErr({});
    }
  }, [open, branchId]);
  const add = useApiMutation(institutionBranchesContract.addHoliday, {
    invalidate: [['institution'], ['academics'], ['teaching']],
    success: (r) => `${r.holiday.name} added · ${r.suppressed} session${r.suppressed === 1 ? '' : 's'} suppressed`,
    toastError: false,
    onError: (e) => setErr(apiErrors(e)),
    onSuccess: () => {
      setDate('');
      setName('');
      setErr({});
    },
  });
  const [confirming, setConfirming] = useState<string | null>(null);
  const remove = useApiMutation(institutionBranchesContract.removeHoliday, {
    invalidate: [['institution'], ['academics'], ['teaching']],
    success: (r) => `Holiday removed · ${r.restored} session${r.restored === 1 ? '' : 's'} back on the timetable`,
    onSuccess: () => setConfirming(null),
  });
  const submit = () => {
    const e: FieldErrors = {};
    if (!date) e.date = 'Pick the date';
    if (name.trim().length < 2) e.name = 'Name the holiday';
    if (Object.keys(e).length) return setErr(e);
    add.mutate({ body: { date, name: name.trim(), branchId: scope || null } });
  };
  const canManage = list.data?.canManage ?? false;
  const items = list.data?.items ?? [];
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={680}
      kicker={`Holiday calendar · ${list.data?.academicYearLabel ?? ''}`}
      title="Holidays"
      description="Holidays suppress that day’s sessions and pause fee reminders automatically. Removing a future holiday puts its sessions back."
    >
      <div className="grid max-h-[46vh] overflow-auto border border-divider">
        {list.isPending && <Skeleton className="h-24 m-3" />}
        {items.map((h) => (
          <div key={h.id} data-testid="holiday-row" className={cn('flex justify-between gap-3 items-center px-3 py-2 border-b border-divider text-[13px] last:border-b-0', h.past && 'text-neutral-500')}>
            <div className="min-w-0">
              <div className="font-medium text-ink">
                {h.longLabel} · {h.name}
              </div>
              <div className="text-[11px] text-neutral-600">
                {h.scopeLabel}
                {h.suppressedSessions > 0 ? ` · ${h.suppressedSessions} session${h.suppressedSessions === 1 ? '' : 's'} suppressed` : ''}
                {h.past ? ' · past' : ''}
              </div>
            </div>
            {canManage &&
              !h.past &&
              (confirming === h.id ? (
                <span className="inline-flex gap-1 items-center">
                  <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                    Keep
                  </Button>
                  <Button variant="ink" size="sm" loading={remove.isPending && remove.variables?.params.id === h.id} onClick={() => remove.mutate({ params: { id: h.id } })}>
                    {h.suppressedSessions ? `Remove · ${h.suppressedSessions} session${h.suppressedSessions === 1 ? '' : 's'} back on` : 'Remove holiday'}
                  </Button>
                </span>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setConfirming(h.id)}>
                  Remove
                </Button>
              ))}
          </div>
        ))}
        {list.data && items.length === 0 && <EmptyState className="py-5" title="No holidays this academic year" body="Add the first one below." />}
      </div>
      {canManage && (
        <div className="grid gap-2 border-t border-divider pt-2.5">
          <div className="text-xs text-ink/70">Add a holiday</div>
          <div className="grid sm:grid-cols-[150px_1fr_170px_auto] gap-2 items-start">
            <Field label="Date" error={err.date}>
              <Input type="date" min={todayIST()} value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Holiday" error={err.name}>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Onam" />
            </Field>
            <Field label="Applies to" error={err.branchId}>
              <Select value={scope} onChange={(e) => setScope(e.target.value)} options={[{ value: '', label: 'All branches' }, ...(branches.data?.branches ?? []).map((b) => ({ value: b.id, label: b.name }))]} />
            </Field>
            <Button variant="primary" className="sm:mt-[21px]" loading={add.isPending} onClick={submit}>
              Add holiday
            </Button>
          </div>
          {err._ && !err.date && !err.name && !err.branchId && <Issue>{err._}</Issue>}
        </div>
      )}
    </Dialog>
  );
}
