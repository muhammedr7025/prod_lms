'use client';

import { academicsStudentsContract, type AcadStudentDetail } from '@exatech/contracts';
import { daysBetween, formatDate, formatINR, todayIST, transferAdjustment } from '@exatech/domain';
import { Button, Dialog, Field, Input, Issue, Select, Skeleton } from '@exatech/ui';
import { useEffect, useState } from 'react';
import { useApi, useApiMutation } from '@/lib/hooks';

/** Transfer batch: target of the same course with seats, effective date, logged reason, pro-rated adjustment preview. */
export function TransferDialog({ student, open, onClose }: { student: AcadStudentDetail; open: boolean; onClose: () => void }) {
  const opts = useApi(academicsStudentsContract.transferOptions, { params: { id: student.id } }, { enabled: open });
  const [to, setTo] = useState('');
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) {
      setTo('');
      setReason('');
    }
  }, [open]);
  useEffect(() => {
    if (opts.data && !date) setDate(opts.data.defaultEffectiveDate);
  }, [opts.data, date]);
  const transfer = useApiMutation(academicsStudentsContract.transfer, {
    invalidate: [['academics'], ['finance'], ['reference']],
    success: (d) => `Transferred · adjustment ${d.adjustment >= 0 ? '+' : ''}${formatINR(d.adjustment)} sent to Finance`,
    onSuccess: onClose,
  });
  const d = opts.data;
  const target = d?.targets.find((t) => t.batchId === to);
  const span = d ? Math.max(1, daysBetween(d.from.startDate, d.from.endDate)) : 1;
  const progress = d && date ? Math.max(0, Math.min(100, Math.round((daysBetween(d.from.startDate, date) / span) * 100))) : 0;
  const adjustment = d && target ? transferAdjustment(d.from.feeTotal, target.feeTotal, progress) : 0;
  const past = !!date && date < todayIST();
  const note = !d
    ? ''
    : !target
      ? `Pick a ${student.courseName ?? 'same-course'} batch with free seats. The old enrollment is kept as “transferred”; attendance from the effective date counts in the new batch.`
      : `Course ${progress}% done by ${formatDate(date)} · fee ${formatINR(d.from.feeTotal)} → ${formatINR(target.feeTotal)} · pro-rated adjustment ${adjustment >= 0 ? '+' : ''}${formatINR(adjustment)} (Finance applies it to the fee account).`;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={520}
      kicker={`Enrollment · ${student.admissionNo ?? student.name}`}
      title={`Transfer ${student.name} · from ${d?.from.code ?? student.batchCode ?? '…'}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!target || target.disabled || reason.trim().length < 3 || !date || past} loading={transfer.isPending} onClick={() => transfer.mutate({ params: { id: student.id }, body: { toBatchId: to, effectiveDate: date, reason: reason.trim() } })}>
            Transfer
          </Button>
        </>
      }
    >
      {opts.isPending && <Skeleton className="h-24" />}
      {opts.error && <Issue kind="blocked">{opts.error.message}</Issue>}
      {d && (
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="To batch">
            <Select value={to} onChange={(e) => setTo(e.target.value)} placeholder="Choose…" options={d.targets.map((t) => ({ value: t.batchId, label: t.label, disabled: t.disabled }))} />
          </Field>
          <Field label="Effective from" error={past ? 'Cannot be in the past' : null}>
            <Input type="date" value={date} min={todayIST()} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Reason (logged)" className="col-span-2">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Schedule clash with college hours" />
          </Field>
        </div>
      )}
      {d && d.targets.length === 0 && <Issue kind="blocked">No other {student.courseName} batch in your branches has seats</Issue>}
      <div className="text-[13px] text-neutral-700">{note}</div>
    </Dialog>
  );
}
