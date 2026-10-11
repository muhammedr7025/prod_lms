'use client';

import { admissionsContract, type AdmissionRow } from '@exatech/contracts';
import { Button, Card, Dialog, EmptyState, Field, Issue, Kicker, Mono, Page, PageHeader, Radio, Seg, Skeleton, Table, TableScroll, Tag, TD, TH, Textarea } from '@exatech/ui';
import { useEffect, useState } from 'react';
import { useCan } from '@/components/me-context';
import { useApi, useApiMutation } from '@/lib/hooks';
import { StepBar } from './step-bar';

type View = 'queue' | 'returned' | 'approved' | 'waitlist';
const VIEWS: { value: View; label: string }[] = [
  { value: 'queue', label: 'Awaiting approval' },
  { value: 'returned', label: 'Returned' },
  { value: 'approved', label: 'Approved' },
  { value: 'waitlist', label: 'Waitlist' },
];

function ReturnDialog({ row, onClose }: { row: AdmissionRow | null; onClose: () => void }) {
  const [to, setTo] = useState<'sales' | 'finance'>('sales');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (row) {
      setTo('sales');
      setNote('');
    }
  }, [row]);
  const m = useApiMutation(admissionsContract.returnApp, { invalidate: [['admissions']], success: (r) => `Returned to ${r.returnedTo === 'finance' ? 'Finance' : 'Sales'} · ${r.studentName}`, onSuccess: onClose });
  if (!row) return null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      kicker={`${row.batchCode} · ${row.stepLabel}`}
      title={`Return ${row.studentName}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.isPending} disabled={note.trim().length < 3} onClick={() => m.mutate({ params: { id: row.id }, body: { to, note: note.trim() } })}>
            Return
          </Button>
        </>
      }
    >
      <div className="flex gap-4" role="radiogroup" aria-label="Return to">
        <Radio name="return-to" checked={to === 'sales'} onChange={() => setTo('sales')} label={`Sales (${row.salesName})`} />
        <Radio name="return-to" checked={to === 'finance'} onChange={() => setTo('finance')} label="Finance" />
      </div>
      {to === 'finance' && !row.financeVerified && <Issue kind="blocked">Finance has not verified this application yet — return it to Sales instead.</Issue>}
      <Field label="Note for the person fixing it">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Qualification certificate missing — please upload before resubmitting." autoFocus />
      </Field>
    </Dialog>
  );
}

/** Branch Admin · Admissions — the approval queue (Sales → Finance → you). */
export function AdmissionsQueueScreen() {
  const [view, setView] = useState<View>('queue');
  const canApprove = useCan('admissions:approve');
  const q = useApi(admissionsContract.list, { query: { status: view } }, { placeholderData: (p) => p });
  const [returning, setReturning] = useState<AdmissionRow | null>(null);
  const approve = useApiMutation(admissionsContract.approve, {
    invalidate: [['admissions'], ['sales'], ['reference']],
    success: (r) => `Approved · ${r.admissionNo} · ${r.studentName}`,
  });
  const items = q.data?.items ?? [];
  const showing = q.data && !q.isPlaceholderData;
  return (
    <Page label="Branch Admin · Admissions">
      <PageHeader
        kicker="Sales submits → Finance verifies → you approve"
        title="Admissions"
        actions={<Seg aria-label="Admissions view" value={view} onChange={setView} options={VIEWS} />}
      />
      <Card pad="none">
        <TableScroll minWidth={980}>
          <Table>
            <thead>
              <tr>
                <TH>Applicant</TH>
                <TH>Batch</TH>
                <TH>Salesperson</TH>
                <TH>Fee plan</TH>
                <TH>Discount</TH>
                <TH>Steps</TH>
                <TH>Documents</TH>
                <TH />
              </tr>
            </thead>
            <tbody>
              {!q.data &&
                Array.from({ length: 4 }, (_, i) => (
                  <tr key={i}>
                    <TD colSpan={8}>
                      <Skeleton className="h-9" />
                    </TD>
                  </tr>
                ))}
              {items.map((a) => {
                const pending = a.status === 'submitted' || a.status === 'fee_verified';
                const blocked = a.approveBlockedReason;
                const approving = approve.isPending && approve.variables?.params.id === a.id;
                return (
                  <tr key={a.id} data-testid="admission-row" aria-label={a.studentName}>
                    <TD>
                      <b className="font-medium">{a.studentName}</b>
                      <div className="text-xs text-neutral-600">{a.guardianLine}</div>
                    </TD>
                    <TD>
                      {a.batchCode}
                      {a.waitlist ? (a.seatsLeft > 0 ? ' · from waitlist' : ' · waitlist') : ''}
                      <div className="text-xs text-neutral-600" data-testid="seats-line">
                        {a.seatsLine}
                      </div>
                    </TD>
                    <TD>{a.salesName.split(' ')[0]}</TD>
                    <TD className="text-xs">{a.planLine}</TD>
                    <TD className="tabular">
                      {a.discountPct ? `${a.discountPct}%` : '—'}
                      {a.needsSuperAdmin && <div className="text-[11px] text-neutral-600">{a.superAdminApproved ? 'SA approved' : 'needs SA'}</div>}
                    </TD>
                    <TD>
                      <StepBar row={a} withLabel />
                    </TD>
                    <TD>
                      <Tag variant={a.docs.missing.length ? 'plain' : 'accent'} title={a.docs.missing.length ? `Missing: ${a.docs.missing.join(', ')}` : undefined}>
                        {a.docs.uploaded}/{a.docs.required}
                        {a.docs.missing.length ? ` · ${a.docs.missing[0]!.split(' ')[0]!.toLowerCase()} missing` : ''}
                      </Tag>
                    </TD>
                    <TD className="pr-4">
                      {pending && canApprove && (
                        <div className="grid justify-items-end gap-1">
                          <div className="flex gap-1.5 justify-end">
                            <Button size="sm" variant="secondary" onClick={() => setReturning(a)}>
                              Return
                            </Button>
                            <Button size="sm" variant="primary" disabled={!!blocked} loading={approving} onClick={() => approve.mutate({ params: { id: a.id } })} title={blocked ?? undefined}>
                              Approve
                            </Button>
                          </div>
                          {blocked && <div className="text-[11px] text-neutral-600 max-w-[220px] text-right">{blocked}</div>}
                        </div>
                      )}
                      {a.status === 'approved' && (
                        <div className="text-right text-xs">
                          <Tag variant="accent">Approved</Tag>
                          <div className="mt-1">
                            <Mono>{a.admissionNo}</Mono>
                          </div>
                        </div>
                      )}
                      {a.status === 'returned' && (
                        <div className="text-right text-xs max-w-[240px] ml-auto">
                          <Tag variant="ink">Returned to {a.returnedTo === 'finance' ? 'Finance' : 'Sales'}</Tag>
                          {a.returnNote && <div className="mt-1 text-neutral-700">{a.returnNote}</div>}
                        </div>
                      )}
                      {a.status === 'waitlisted' && <Tag variant="neutral">Waitlisted</Tag>}
                    </TD>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </TableScroll>
        {showing && items.length === 0 && (
          <EmptyState
            title={view === 'queue' ? 'Nothing awaiting approval' : view === 'returned' ? 'No returned applications' : view === 'approved' ? 'No approvals yet' : 'Nobody on the waitlist'}
            body={view === 'queue' ? 'New applications appear here once Sales submits them.' : undefined}
          />
        )}
        {q.error && <EmptyState title="Could not load admissions" body={q.error.message} />}
      </Card>
      <Card tone="tint" className="gap-1.5">
        <Kicker>On approval · emitted as AdmissionApproved</Kicker>
        <div className="flex gap-4 flex-wrap text-[13px]">
          <span>Student + parent accounts invited</span>
          <span>·</span>
          <span>Enrollment created</span>
          <span>·</span>
          <span>Invoice schedule generated</span>
          <span>·</span>
          <span>Welcome WhatsApp with first invoice</span>
          <span>·</span>
          <span>Lead marked Won</span>
          <span>·</span>
          <span>Admission number + barcode issued</span>
        </div>
      </Card>
      <ReturnDialog row={returning} onClose={() => setReturning(null)} />
    </Page>
  );
}
