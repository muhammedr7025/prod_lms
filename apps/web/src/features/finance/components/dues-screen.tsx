'use client';

import { AGEING_FILTERS, financeContract, type DuesRow } from '@exatech/contracts';
import { formatDayMonth, formatINR, formatINRCompact } from '@exatech/domain';
import { Button, Card, Dialog, EmptyState, Page, PageHeader, Seg, Select, Skeleton, Sub, Table, TableScroll, Tag, TD, TH, TR } from '@exatech/ui';
import Link from 'next/link';
import { useState } from 'react';
import { useApi, useApiMutation } from '@/lib/hooks';
import { CallDialog } from './account-screen';

type Bucket = (typeof AGEING_FILTERS)[number];
type Promise_ = 'any' | 'promised' | 'none' | 'broken';

/** Dues & follow-up: overdue instalments with ageing, last reminder, promise; reminders stop the moment a payment posts. */
export function DuesScreen() {
  const [bucket, setBucket] = useState<Bucket>('all');
  const [batchId, setBatchId] = useState('');
  const [promise, setPromise] = useState<Promise_>('any');
  const query = { bucket, promise, ...(batchId ? { batchId } : {}) };
  const q = useApi(financeContract.dues, { query }, { placeholderData: (p) => p });
  const batches = useApi(financeContract.batches, {});
  const [calling, setCalling] = useState<DuesRow | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const remind = useApiMutation(financeContract.remind, { invalidate: [['finance']], success: 'Reminder sent · WhatsApp + invoice PDF' });
  const remindAll = useApiMutation(financeContract.remindAll, { invalidate: [['finance']], success: (r) => `Reminders sent to ${r.sent} account${r.sent === 1 ? '' : 's'} · WhatsApp + invoice PDF`, onSuccess: () => setConfirmAll(false) });
  const d = q.data;
  const pending = d?.items.filter((r) => !r.remindedToday).length ?? 0;
  return (
    <Page label="Finance · Dues & follow-up">
      <PageHeader
        kicker={d ? `${d.shown} shown of ${d.total} · ${formatINRCompact(d.totalAmount)} overdue · reminders stop the moment a payment posts` : 'Overdue instalments'}
        title="Dues & follow-up"
        actions={
          <>
            <Button disabled={!pending} title={!pending ? 'Everyone shown has been reminded today' : undefined} onClick={() => setConfirmAll(true)}>
              Remind all (WhatsApp + invoice)
            </Button>
            <Link href="/announcements?segment=overdue_fees">
              <Button variant="primary">Announce to segment</Button>
            </Link>
          </>
        }
      />
      <div className="flex gap-2 flex-wrap">
        <Seg
          aria-label="Ageing"
          value={bucket}
          onChange={setBucket}
          options={[
            { value: 'all', label: 'All' },
            { value: '0-30', label: '0–30 d' },
            { value: '31-60', label: '31–60' },
            { value: '61-90', label: '61–90' },
            { value: '90+', label: '90+' },
          ]}
        />
        <Select className="w-auto" aria-label="Batch" value={batchId} onChange={(e) => setBatchId(e.target.value)} options={[{ value: '', label: 'All batches' }, ...(batches.data ?? []).map((b) => ({ value: b.id, label: `${b.code} · ${b.branchName}` }))]} />
        <Select
          className="w-auto"
          aria-label="Promise-to-pay"
          value={promise}
          onChange={(e) => setPromise(e.target.value as Promise_)}
          options={[
            { value: 'any', label: 'Promise-to-pay: any' },
            { value: 'promised', label: 'Promised (upcoming)' },
            { value: 'broken', label: 'Promise broken' },
            { value: 'none', label: 'No promise' },
          ]}
        />
      </div>
      <Card pad="none">
        <TableScroll minWidth={860}>
          <Table>
            <thead>
              <tr>
                <TH>Student</TH>
                <TH>Batch</TH>
                <TH>Instalment</TH>
                <TH className="text-right">Overdue</TH>
                <TH>Ageing</TH>
                <TH>Last reminder</TH>
                <TH>Promise</TH>
                <TH />
              </tr>
            </thead>
            <tbody>
              {q.isPending &&
                Array.from({ length: 6 }, (_, i) => (
                  <tr key={i}>
                    <TD colSpan={8}>
                      <Skeleton className="h-6" />
                    </TD>
                  </tr>
                ))}
              {d?.items.map((r) => (
                <TR key={r.instalmentId} data-student={r.studentName}>
                  <TD>
                    <Link href={`/finance/accounts/${r.enrollmentId}`} className="font-medium text-ink no-underline hover:underline underline-offset-[3px]">
                      {r.studentName}
                    </Link>
                    <Sub>{r.guardianLine}</Sub>
                  </TD>
                  <TD className="whitespace-nowrap">{r.batchCode}</TD>
                  <TD className="whitespace-nowrap">{r.instalment}</TD>
                  <TD className="text-right font-semibold tabular">{formatINR(r.overdue)}</TD>
                  <TD>
                    <Tag variant={r.ageTag}>{r.ageLabel}</Tag>
                  </TD>
                  <TD className="text-xs text-neutral-700">{r.lastReminder}</TD>
                  <TD>{r.promiseDate ? <Tag variant="outline">{formatDayMonth(r.promiseDate)}</Tag> : '—'}</TD>
                  <TD className="text-right whitespace-nowrap">
                    <Button size="sm" disabled={r.remindedToday} loading={remind.isPending && remind.variables?.body.instalmentIds[0] === r.instalmentId} onClick={() => remind.mutate({ body: { instalmentIds: [r.instalmentId] } })}>
                      {r.remindedToday ? 'Reminded' : 'Remind'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setCalling(r)}>
                      Call
                    </Button>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableScroll>
        {d && d.items.length === 0 && <EmptyState title={d.total === 0 ? 'Nothing overdue' : 'No dues match these filters'} body={d.total === 0 ? 'Every instalment due so far is paid.' : 'Widen the ageing bucket or clear the batch / promise filters.'} />}
        {q.error && <EmptyState title="Could not load dues" body={q.error.message} />}
      </Card>
      <CallDialog enrollmentId={calling?.enrollmentId ?? ''} name={calling?.studentName ?? ''} open={!!calling} onClose={() => setCalling(null)} />
      <Dialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        kicker="Dues · bulk reminder"
        title={`Remind ${pending} account${pending === 1 ? '' : 's'}?`}
        description="Sends WhatsApp (fee_reminder) and email with the invoice PDF to each student and parent in this list who has not been reminded today. Fee-due messages cannot be muted."
        footer={
          <>
            <Button onClick={() => setConfirmAll(false)}>Cancel</Button>
            <Button variant="primary" loading={remindAll.isPending} onClick={() => remindAll.mutate({ body: query })}>
              Send {pending} reminder{pending === 1 ? '' : 's'}
            </Button>
          </>
        }
      />
    </Page>
  );
}
