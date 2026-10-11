'use client';

import { financeContract, type Reconciliation } from '@exatech/contracts';
import { formatINR } from '@exatech/domain';
import { Button, Card, Dialog, EmptyState, Field, Grid, Input, Issue, Mono, Page, PageHeader, Select, Skeleton, Stat, Sub, Table, TableScroll, Tag, TD, Textarea, TH, TR, toast } from '@exatech/ui';
import { useEffect, useRef, useState } from 'react';
import { uploadFile } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { invalidatePrefixes, useApi, useApiMutation } from '@/lib/hooks';

type Item = Reconciliation['items'][number];

function AdvanceDialog({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const [qs, setQs] = useState('');
  const [enrollmentId, setEnrollmentId] = useState('');
  useEffect(() => {
    if (item) {
      setSearch('');
      setEnrollmentId('');
    }
  }, [item]);
  useEffect(() => {
    const t = setTimeout(() => setQs(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const list = useApi(financeContract.accounts, { query: { ...(qs ? { q: qs } : {}), filter: 'all', limit: 8 } }, { enabled: !!item && qs.length >= 2 });
  const m = useApiMutation(financeContract.recordAdvance, { invalidate: [['finance']], success: (r) => `Recorded on ${r.studentName}'s account · receipt ${r.receiptNumber}`, onSuccess: onClose });
  if (!item) return null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      width={520}
      kicker={`${item.gatewayPaymentId} · ${formatINR(item.amount)}`}
      title="Record as advance"
      description={`Credit ${formatINR(item.amount)} to a student's fee account (channel: reconciliation). It is allocated oldest-due-first; anything left is held as credit. ${item.notes ? `Gateway notes: “${item.notes}”.` : ''}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!enrollmentId} loading={m.isPending} onClick={() => m.mutate({ params: { itemId: item.id }, body: { enrollmentId } })}>
            Record on account
          </Button>
        </>
      }
    >
      <Field label="Student">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or admission no." autoFocus aria-label="Find student" />
      </Field>
      <div className="grid gap-1 max-h-56 overflow-auto" role="listbox" aria-label="Students">
        {list.data?.items.map((r) => (
          <button
            key={r.enrollmentId}
            type="button"
            role="option"
            aria-selected={enrollmentId === r.enrollmentId}
            onClick={() => setEnrollmentId(r.enrollmentId)}
            className={`text-left border px-3 py-2 text-[13px] cursor-pointer ${enrollmentId === r.enrollmentId ? 'border-accent bg-accent-100' : 'border-divider hover:bg-ink/4'}`}
          >
            <b className="font-medium">{r.studentName}</b> · {r.admissionNo ?? '—'} · {r.batchCode} · outstanding {formatINR(r.outstanding)}
          </button>
        ))}
        {list.data && list.data.items.length === 0 && <div className="text-[13px] text-neutral-600">No student matches “{qs}”.</div>}
      </div>
      {!enrollmentId && <Issue kind="needed">Choose the student this money belongs to</Issue>}
    </Dialog>
  );
}

function InvestigateDialog({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const [note, setNote] = useState('');
  useEffect(() => setNote(''), [item]);
  const m = useApiMutation(financeContract.resolveItem, { invalidate: [['finance']], success: 'Resolved · note kept with the settlement', onSuccess: onClose });
  if (!item) return null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      kicker={`${item.gatewayPaymentId} · ${formatINR(item.amount)}${item.recordedAmount !== null ? ` vs recorded ${formatINR(item.recordedAmount)}` : ''}`}
      title="Investigate"
      description="Record what you found (gateway fee deducted, partial refund, duplicate…). The item is marked resolved; recorded payments are not changed."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={note.trim().length < 5} loading={m.isPending} onClick={() => m.mutate({ params: { itemId: item.id }, body: { note: note.trim() } })}>
            Resolve
          </Button>
        </>
      }
    >
      <Field label="Finding">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="₹500 partial refund issued on Razorpay dashboard on 9 Oct" className="min-h-[70px]" autoFocus />
      </Field>
    </Dialog>
  );
}

/** Reconciliation: settlement vs recorded payments, auto-match by payment id + amount, decisions for exceptions. */
export function ReconciliationScreen() {
  const [settlementId, setSettlementId] = useState<string | undefined>(undefined);
  const q = useApi(financeContract.reconciliation, { query: settlementId ? { settlementId } : {} }, { placeholderData: (p) => p });
  const d = q.data;
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [advance, setAdvance] = useState<Item | null>(null);
  const [investigate, setInvestigate] = useState<Item | null>(null);
  const match = useApiMutation(financeContract.autoMatch, { invalidate: [['finance']], success: (r) => `Auto-match · ${r.matched} matched · ${r.differs} amount differs · ${r.unmatched} unmatched` });
  const upload = useApiMutation(financeContract.uploadSettlement, {
    invalidate: [['finance']],
    success: (r) => `Settlement uploaded · ${r.items} items · ${r.matched} matched`,
    onSuccess: (r) => setSettlementId(r.settlementId),
  });
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setUploading(true);
    try {
      const stored = await uploadFile(f, 'statement');
      await upload.mutateAsync({ body: { fileId: stored.id, gateway: /bank/i.test(f.name) ? 'bank' : 'razorpay' } });
    } catch (e) {
      if (!upload.isError) toast.error((e as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
      void invalidatePrefixes(qc, [['finance']]);
    }
  };
  const st = d?.settlement;
  return (
    <Page label="Finance · Reconciliation">
      <PageHeader
        kicker={st ? `${st.label} · bank deposits` : 'Razorpay settlements · bank deposits'}
        title="Reconciliation"
        actions={
          <>
            {d && d.settlements.length > 1 && <Select className="w-auto max-w-[320px]" aria-label="Settlement" value={st?.id ?? ''} onChange={(e) => setSettlementId(e.target.value)} options={d.settlements.map((x) => ({ value: x.id, label: x.label }))} />}
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" aria-label="Settlement CSV" data-testid="settlement-file" onChange={(e) => void onFile(e.target.files?.[0])} />
            <Button loading={uploading} onClick={() => fileRef.current?.click()}>
              Upload bank statement
            </Button>
            <Button variant="primary" disabled={!st} loading={match.isPending} onClick={() => st && match.mutate({ params: { settlementId: st.id } })}>
              Auto-match
            </Button>
          </>
        }
      />
      <Grid min={170}>
        {!d ? (
          Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[86px]" />)
        ) : (
          <>
            <Stat size="md" label="Settlement" value={st ? formatINR(st.amount) : '—'} meta={st ? `${st.externalId.length > 12 ? `${st.externalId.slice(0, 8)}…` : st.externalId} · ${st.paymentCount} payments · fees ${formatINR(st.fees)}` : 'Upload a settlement CSV'} />
            <Stat size="md" label="Matched" value={<span className="text-accent-700">{d.matched}</span>} meta="by payment id + amount" />
            <Stat size="md" emphasis label="Unmatched" value={d.unmatched} meta="needs a decision" />
            <Stat size="md" label="Webhooks" value={`${d.webhookFailures} failed`} meta="retried up to 72 h · idempotent" />
          </>
        )}
      </Grid>
      <Card pad="none">
        <TableScroll minWidth={760}>
          <Table>
            <thead>
              <tr>
                <TH>Gateway payment</TH>
                <TH className="text-right">Amount</TH>
                <TH>Recorded payment</TH>
                <TH>Student</TH>
                <TH>Match</TH>
                <TH />
              </tr>
            </thead>
            <tbody>
              {d?.items.map((i) => (
                <TR key={i.id} data-item={i.gatewayPaymentId}>
                  <TD>
                    <Mono>{i.gatewayPaymentId}</Mono>
                  </TD>
                  <TD className="text-right tabular">{formatINR(i.amount)}</TD>
                  <TD>{i.recorded ? <Mono>{i.recorded}</Mono> : <span className="text-neutral-600">— none —</span>}</TD>
                  <TD>
                    {i.studentName ?? <span className="text-neutral-600">unknown{i.notes ? ` · notes: “${i.notes}”` : ''}</span>}
                    {i.resolution && <Sub>{i.resolution}</Sub>}
                  </TD>
                  <TD>
                    <Tag variant={i.tag}>{i.statusLabel}</Tag>
                  </TD>
                  <TD className="text-right whitespace-nowrap">
                    {i.status === 'unmatched' && (
                      <>
                        <Button size="sm" onClick={() => setAdvance(i)}>
                          Record as advance
                        </Button>{' '}
                        <Button size="sm" variant="ghost" onClick={() => setInvestigate(i)}>
                          Investigate
                        </Button>
                      </>
                    )}
                    {i.status === 'amount_differs' && (
                      <Button size="sm" onClick={() => setInvestigate(i)}>
                        Investigate
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableScroll>
        {!d && (
          <div className="p-4 grid gap-2">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-6" />
            ))}
          </div>
        )}
        {d && !st && <EmptyState title="No settlements yet" body="Upload a Razorpay settlement or bank statement CSV (payment_id, amount, notes) to reconcile it against recorded payments." />}
        {d && st && d.items.length === 0 && <EmptyState title="No items in this settlement" />}
        {q.error && <EmptyState title="Could not load reconciliation" body={q.error.message} />}
      </Card>
      <AdvanceDialog item={advance} onClose={() => setAdvance(null)} />
      <InvestigateDialog item={investigate} onClose={() => setInvestigate(null)} />
    </Page>
  );
}
