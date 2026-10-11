'use client';

import { teachingCoverContract, TEACH_ADHOC_TYPES } from '@exatech/contracts';
import { Button, Dialog, Field, Input, Select, Skeleton } from '@exatech/ui';
import { useEffect, useState } from 'react';
import { useApi, useApiMutation } from '@/lib/hooks';

type AdhocType = (typeof TEACH_ADHOC_TYPES)[number];

/** "Cover another class": start an ad-hoc session for any batch in my branch, then load its roster. */
export function CoverDialog({ open, onOpenChange, onStarted }: { open: boolean; onOpenChange: (o: boolean) => void; onStarted: (sessionId: string) => void }) {
  const { data, isPending } = useApi(teachingCoverContract.options, {}, { enabled: open, staleTime: 0 });
  const [batchId, setBatchId] = useState('');
  const [type, setType] = useState<AdhocType>('substitute');
  const [slot, setSlot] = useState('');
  const [reason, setReason] = useState('');
  const start = useApiMutation(teachingCoverContract.start, {
    invalidate: [['teaching']],
    success: 'Ad-hoc session started · Branch Admin notified',
    onSuccess: (d) => {
      onOpenChange(false);
      onStarted(d.sessionId);
    },
  });
  useEffect(() => {
    if (open) {
      setBatchId('');
      setType('substitute');
      setReason('');
      setSlot('');
    }
  }, [open]);
  useEffect(() => {
    if (data && !slot) setSlot(data.slots[0]?.value ?? '');
  }, [data, slot]);
  const chosen = data?.batches.find((b) => b.id === batchId);
  const cannotSave = !batchId || !slot || reason.trim().length < 3;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      kicker="Attendance · outside your timetable"
      title="Cover another class"
      width={480}
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" disabled={cannotSave} loading={start.isPending} onClick={() => start.mutate({ body: { batchId, type, start: slot, reason: reason.trim() } })}>
            Load roster
          </Button>
        </>
      }
    >
      {isPending ? (
        <Skeleton className="h-[120px]" />
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="Batch (your branch)">
            <Select className="min-h-11" value={batchId} onChange={(e) => setBatchId(e.target.value)} placeholder="Choose…" options={(data?.batches ?? []).map((b) => ({ value: b.id, label: b.code }))} />
          </Field>
          <Field label="Session type">
            <Select className="min-h-11" value={type} onChange={(e) => setType(e.target.value as AdhocType)} options={(data?.types ?? []).map((t) => ({ value: t.value, label: t.label }))} />
          </Field>
          <Field label="Start">
            <Select className="min-h-11" value={slot} onChange={(e) => setSlot(e.target.value)} options={(data?.slots ?? []).map((t) => ({ value: t.value, label: t.label }))} />
          </Field>
          <Field label="Reason (required · logged)">
            <Input className="min-h-11" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Sanjay unwell · covering React" maxLength={200} />
          </Field>
        </div>
      )}
      {chosen && (
        <div className="text-xs text-neutral-600">
          {chosen.label}
          {chosen.regularTeacher ? ` · regular teacher ${chosen.regularTeacher}` : ''}
        </div>
      )}
      <div className="text-xs text-neutral-600">You pick the subject taught on the attendance screen — it can differ from the batch&apos;s regular subject.</div>
      <div className="text-[13px] text-neutral-700">
        The batch roster loads for marking. The session is flagged <b className="font-semibold">ad-hoc</b> in the Branch overview; attendance counts toward the students once the Branch Admin acknowledges it. The regular teacher is notified.
      </div>
    </Dialog>
  );
}
