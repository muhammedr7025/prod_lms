'use client';

import { teachingLeaveContract, TEACH_LEAVE_LABEL, TEACH_LEAVE_TYPES } from '@exatech/contracts';
import { Button, Dialog, Field, Input, Issue, Select } from '@exatech/ui';
import { useEffect, useState } from 'react';
import { useApi, useApiMutation } from '@/lib/hooks';
import { NeededList, todayISTClient } from './parts';

type LeaveType = (typeof TEACH_LEAVE_TYPES)[number];

/** Request leave: shows which of my sessions that day will need a substitute; pending until the Branch Admin approves. */
export function LeaveDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [date, setDate] = useState('');
  const [type, setType] = useState<LeaveType>('casual');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) {
      setDate('');
      setType('casual');
      setReason('');
    }
  }, [open]);
  const today = todayISTClient();
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= today;
  const impact = useApi(teachingLeaveContract.impact, { query: { date: validDate ? date : today } }, { enabled: open && validDate });
  const send = useApiMutation(teachingLeaveContract.request, {
    invalidate: [['teaching']],
    success: 'Leave requested · pending Branch Admin approval',
    onSuccess: () => onOpenChange(false),
  });
  const issues = [...(!date ? ['Pick the date'] : !validDate ? ['Pick today or a later date'] : []), ...(reason.trim().length < 2 ? ['Give a reason'] : [])];
  const blocked = validDate ? impact.data?.existing : null;
  const affected = !validDate ? 'Pick a date to see which sessions need a substitute' : impact.data ? impact.data.label : 'Checking your sessions…';

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      kicker="Leave · approved by Branch Admin"
      title="Request leave"
      width={460}
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" disabled={issues.length > 0 || !!blocked} loading={send.isPending} onClick={() => send.mutate({ body: { date, type, reason: reason.trim() } })}>
            Send request
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Date">
          <Input type="date" className="min-h-11" value={date} min={today} onChange={(e) => setDate(e.target.value)} autoFocus />
        </Field>
        <Field label="Type">
          <Select className="min-h-11" value={type} onChange={(e) => setType(e.target.value as LeaveType)} options={TEACH_LEAVE_TYPES.map((t) => ({ value: t, label: TEACH_LEAVE_LABEL[t] }))} />
        </Field>
        <Field label="Reason" className="col-span-2">
          <Input className="min-h-11" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Family function" maxLength={200} />
        </Field>
      </div>
      <div className="text-[13px] text-neutral-700" data-testid="leave-affected">
        {affected}. On approval the substitute flow starts automatically.
      </div>
      {blocked && <Issue kind="blocked">{blocked}</Issue>}
      <NeededList items={issues} />
    </Dialog>
  );
}
