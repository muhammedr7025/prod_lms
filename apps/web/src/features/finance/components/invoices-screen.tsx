'use client';

import { DOCUMENT_PATHS, FINANCE_DOCUMENT_PATHS, financeContract, type InvoiceRow, type ReceiptRow } from '@exatech/contracts';
import { formatDayMonth, formatINR } from '@exatech/domain';
import { Button, Card, Dialog, EmptyState, Field, Input, Issue, Mono, Page, PageHeader, Seg, Select, Skeleton, Sub, Table, TableScroll, Tag, TD, Textarea, TH, TR } from '@exatech/ui';
import { useEffect, useMemo, useState } from 'react';
import { useCan } from '@/components/me-context';
import { useApi, useApiMutation } from '@/lib/hooks';
import { openDoc, recentMonths } from '../lib';

type Kind = 'invoices' | 'receipts' | 'credit_notes';

const STATUS: Record<Kind, { value: string; label: string }[]> = {
  invoices: [
    { value: '', label: 'All statuses' },
    { value: 'paid', label: 'Paid' },
    { value: 'partially_paid', label: 'Partially paid' },
    { value: 'overdue', label: 'Overdue' },
    { value: 'issued', label: 'Issued · not due' },
    { value: 'cancelled', label: 'Cancelled' },
  ],
  receipts: [
    { value: '', label: 'All statuses' },
    { value: 'cleared', label: 'Cleared' },
    { value: 'pending_clearance', label: 'Pending clearance' },
    { value: 'voided', label: 'Voided' },
    { value: 'bounced', label: 'Bounced' },
  ],
  credit_notes: [{ value: '', label: 'All' }],
};

function ReasonDialog(props: { open: boolean; onClose: () => void; kicker: string; title: string; description: string; confirm: string; loading: boolean; onConfirm: (reason: string) => void; warn?: string | null }) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (props.open) setReason('');
  }, [props.open]);
  return (
    <Dialog
      open={props.open}
      onOpenChange={(o) => !o && props.onClose()}
      kicker={props.kicker}
      title={props.title}
      description={props.description}
      footer={
        <>
          <Button onClick={props.onClose}>Keep</Button>
          <Button variant="ink" loading={props.loading} disabled={reason.trim().length < 5} onClick={() => props.onConfirm(reason.trim())}>
            {props.confirm}
          </Button>
        </>
      }
    >
      <Field label="Reason (required)">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Duplicate entry" className="min-h-[60px]" autoFocus />
      </Field>
      {props.warn && <Issue kind="needed">{props.warn}</Issue>}
    </Dialog>
  );
}

function BulkDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const batches = useApi(financeContract.batches, {}, { enabled: open });
  const [batchId, setBatchId] = useState('');
  const [days, setDays] = useState('7');
  const within = Math.max(0, Math.min(90, Number(days) || 0));
  const preview = useApi(financeContract.bulkPreview, { query: { batchId, withinDays: within } }, { enabled: open && !!batchId });
  const m = useApiMutation(financeContract.bulkGenerate, { invalidate: [['finance']], success: (r) => `${r.issued} invoice${r.issued === 1 ? '' : 's'} issued · ${formatINR(r.amount)}`, onSuccess: onClose });
  useEffect(() => {
    if (open && !batchId && batches.data?.[0]) setBatchId(batches.data[0].id);
  }, [open, batches.data, batchId]);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      kicker="Invoices · bulk"
      title="Bulk generate for batch"
      description="Issues GST invoices (gap-free numbers) for every instalment in the batch due within the window that has no invoice yet."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!preview.data?.count} loading={m.isPending} onClick={() => m.mutate({ body: { batchId, withinDays: within } })}>
            Generate {preview.data?.count ? `${preview.data.count} invoice${preview.data.count === 1 ? '' : 's'}` : ''}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[1fr_140px] gap-2.5">
        <Field label="Batch">
          <Select value={batchId} onChange={(e) => setBatchId(e.target.value)} options={(batches.data ?? []).map((b) => ({ value: b.id, label: `${b.code} · ${b.branchName}` }))} placeholder={batches.isPending ? 'Loading…' : undefined} />
        </Field>
        <Field label="Due within (days)">
          <Input type="number" min={0} max={90} value={days} onChange={(e) => setDays(e.target.value)} />
        </Field>
      </div>
      {preview.data && (preview.data.count ? <Issue kind="ok">{`${preview.data.count} instalments · ${preview.data.students} students · ${formatINR(preview.data.amount)}`}</Issue> : <Issue kind="needed">Nothing to invoice — every instalment due in this window already has an invoice</Issue>)}
    </Dialog>
  );
}

/** Invoices & receipts: gap-free series, PDF / reprint (watermarked) / cancel (credit note) / void, bulk generation. */
export function InvoicesScreen() {
  const [kind, setKind] = useState<Kind>('invoices');
  const [search, setSearch] = useState('');
  const [qs, setQs] = useState('');
  const [status, setStatus] = useState('');
  const months = useMemo(() => recentMonths(12), []);
  const [month, setMonth] = useState(months[0]!.value);
  useEffect(() => {
    const t = setTimeout(() => setQs(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setStatus(''), [kind]);
  const query = { ...(qs ? { q: qs } : {}), ...(status ? { status } : {}), ...(month ? { month } : {}), limit: 50 };
  const inv = useApi(financeContract.invoices, { query }, { enabled: kind === 'invoices', placeholderData: (p) => p });
  const rec = useApi(financeContract.receipts, { query }, { enabled: kind === 'receipts', placeholderData: (p) => p });
  const cns = useApi(financeContract.creditNotes, { query }, { enabled: kind === 'credit_notes', placeholderData: (p) => p });
  const canVoid = useCan('finance:void');
  const canCollect = useCan('finance:payment.collect');
  const [cancelling, setCancelling] = useState<InvoiceRow | null>(null);
  const [voiding, setVoiding] = useState<ReceiptRow | null>(null);
  const [bulk, setBulk] = useState(false);

  const reprintInv = useApiMutation(financeContract.reprintInvoice, { invalidate: [['finance']], success: (r) => `Duplicate #${r.reprintCount} · watermarked and logged`, onSuccess: (r) => openDoc(r.url) });
  const reprintRec = useApiMutation(financeContract.reprintReceipt, { invalidate: [['finance']], success: (r) => `Duplicate #${r.reprintCount} · watermarked and logged`, onSuccess: (r) => openDoc(r.url) });
  const cancel = useApiMutation(financeContract.cancelInvoice, { invalidate: [['finance']], success: (r) => `Invoice cancelled · credit note ${r.creditNoteNumber}`, onSuccess: () => setCancelling(null) });
  const voidRec = useApiMutation(financeContract.voidReceipt, { invalidate: [['finance'], ['approvals']], success: (r) => r.message, onSuccess: () => setVoiding(null) });
  const cheque = useApiMutation(financeContract.chequeOutcome, { invalidate: [['finance'], ['students']], success: (_r, a) => (a.body.outcome === 'cleared' ? 'Cheque cleared · fee clearance recomputed' : 'Cheque bounced · allocation reversed') });

  const active = kind === 'invoices' ? inv : kind === 'receipts' ? rec : cns;
  const prefix = (n: string) => n.split('/').slice(0, -1).join('/');
  const series = [...new Set(((active.data?.items ?? []) as { number: string }[]).map((r) => prefix(r.number)))].slice(0, 3);

  return (
    <Page label="Finance · Invoices & receipts">
      <PageHeader
        kicker={`Gap-free series per branch per FY${series.length ? ` · ${series.join(' · ')}` : ''}`}
        title="Invoices & receipts"
        actions={
          <>
            <Seg
              aria-label="Documents"
              value={kind}
              onChange={setKind}
              options={[
                { value: 'invoices', label: 'Invoices' },
                { value: 'receipts', label: 'Receipts' },
                { value: 'credit_notes', label: 'Credit notes' },
              ]}
            />
            <Button variant="primary" onClick={() => setBulk(true)}>
              Bulk generate for batch
            </Button>
          </>
        }
      />
      <div className="flex gap-2 flex-wrap">
        <Input placeholder="Number, student, admission no." value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-[280px]" aria-label="Search documents" />
        {kind !== 'credit_notes' && <Select className="w-auto" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={STATUS[kind]} />}
        <Select className="w-auto" aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)} options={[...months, { value: '', label: 'All months' }]} />
      </div>
      <Card pad="none">
        <TableScroll minWidth={860}>
          {kind === 'invoices' && (
            <Table>
              <thead>
                <tr>
                  <TH>Number</TH>
                  <TH>Student</TH>
                  <TH>Line items</TH>
                  <TH>Due</TH>
                  <TH className="text-right">Amount</TH>
                  <TH className="text-right">Paid</TH>
                  <TH>Status</TH>
                  <TH />
                </tr>
              </thead>
              <tbody>
                {inv.data?.items.map((r) => (
                  <TR key={r.id} data-number={r.number}>
                    <TD>
                      <Mono>{r.number}</Mono>
                    </TD>
                    <TD className="font-medium">
                      {r.studentName}
                      <Sub>{r.batchCode}</Sub>
                    </TD>
                    <TD className="text-xs">{r.items}</TD>
                    <TD>{formatDayMonth(r.dueDate)}</TD>
                    <TD className="text-right tabular">{formatINR(r.amount)}</TD>
                    <TD className="text-right tabular">{formatINR(r.paid)}</TD>
                    <TD>
                      <Tag variant={r.tag}>{r.statusLabel}</Tag>
                    </TD>
                    <TD className="text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" onClick={() => openDoc(DOCUMENT_PATHS.invoice(r.id))}>
                        PDF
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => reprintInv.mutate({ params: { id: r.id } })}>
                        Reprint
                      </Button>
                      <Button size="sm" variant="ghost" disabled={!!r.cancelBlockedReason} title={r.cancelBlockedReason ?? undefined} onClick={() => setCancelling(r)}>
                        Cancel
                      </Button>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
          {kind === 'receipts' && (
            <Table>
              <thead>
                <tr>
                  <TH>Number</TH>
                  <TH>Student</TH>
                  <TH>Tenders</TH>
                  <TH>Date</TH>
                  <TH className="text-right">Amount</TH>
                  <TH>Allocated to</TH>
                  <TH>Status</TH>
                  <TH />
                </tr>
              </thead>
              <tbody>
                {rec.data?.items.map((r) => (
                  <TR key={r.id} data-number={r.number}>
                    <TD>
                      <Mono>{r.number}</Mono>
                    </TD>
                    <TD className="font-medium">
                      {r.studentName}
                      <Sub>{r.batchCode}</Sub>
                    </TD>
                    <TD className="text-xs">{r.tenders}</TD>
                    <TD>{formatDayMonth(r.date)}</TD>
                    <TD className="text-right tabular">{formatINR(r.amount)}</TD>
                    <TD className="text-xs">{r.allocatedTo}</TD>
                    <TD>
                      <Tag variant={r.tag}>{r.statusLabel}</Tag>
                    </TD>
                    <TD className="text-right whitespace-nowrap">
                      {r.hasPendingCheque && canCollect && !r.voided && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => cheque.mutate({ params: { id: r.paymentId }, body: { outcome: 'cleared' } })}>
                            Cheque cleared
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => cheque.mutate({ params: { id: r.paymentId }, body: { outcome: 'bounced', note: 'Returned by bank' } })}>
                            Bounced
                          </Button>
                        </>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => openDoc(DOCUMENT_PATHS.receipt(r.id))}>
                        PDF
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => reprintRec.mutate({ params: { id: r.id }, body: { format: 'A4' } })}>
                        Reprint
                      </Button>
                      {canVoid && (
                        <Button size="sm" variant="ghost" disabled={!!r.voidBlockedReason} title={r.voidBlockedReason ?? (r.voidNeedsApproval ? 'Locked period — needs Super Admin approval' : undefined)} onClick={() => setVoiding(r)}>
                          Cancel
                        </Button>
                      )}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
          {kind === 'credit_notes' && (
            <Table>
              <thead>
                <tr>
                  <TH>Number</TH>
                  <TH>Student</TH>
                  <TH>Against</TH>
                  <TH>Date</TH>
                  <TH className="text-right">Amount</TH>
                  <TH>Reason</TH>
                  <TH />
                </tr>
              </thead>
              <tbody>
                {cns.data?.items.map((r) => (
                  <TR key={r.id} data-number={r.number}>
                    <TD>
                      <Mono>{r.number}</Mono>
                    </TD>
                    <TD className="font-medium">
                      {r.studentName}
                      <Sub>{r.batchCode}</Sub>
                    </TD>
                    <TD className="text-xs">{r.against}</TD>
                    <TD>{formatDayMonth(r.date)}</TD>
                    <TD className="text-right tabular">{formatINR(r.amount)}</TD>
                    <TD className="text-xs">{r.reason}</TD>
                    <TD className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => openDoc(FINANCE_DOCUMENT_PATHS.creditNote(r.id))}>
                        PDF
                      </Button>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )}
          {active.isPending && (
            <div className="p-4 grid gap-2">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-6" />
              ))}
            </div>
          )}
        </TableScroll>
        {active.data && active.data.items.length === 0 && <EmptyState title="Nothing in this view" body="Change the month or status, or clear the search." />}
        {active.data && active.data.total > active.data.items.length && <div className="px-4 py-2 text-xs text-neutral-600 border-t border-divider">Showing the latest {active.data.items.length} of {active.data.total} · search or filter to narrow</div>}
        {active.error && <EmptyState title="Could not load documents" body={active.error.message} />}
        <div className="flex justify-between px-4 py-2.5 text-xs text-neutral-600 border-t border-divider flex-wrap gap-2">
          <span>Reprints are watermarked &quot;Duplicate&quot; and logged · cancel issues a credit note, the number stays in the series</span>
          <span>Formats: A4 · A5 · 80 mm thermal · verification QR on every document</span>
        </div>
      </Card>

      <ReasonDialog
        open={!!cancelling}
        onClose={() => setCancelling(null)}
        kicker={cancelling?.number ?? ''}
        title={`Cancel invoice · ${cancelling?.studentName ?? ''}`}
        description={`A credit note for ${formatINR(cancelling?.amount ?? 0)} reverses the charge. ${cancelling?.number ?? ''} stays in the series as cancelled.`}
        confirm="Cancel invoice · issue credit note"
        loading={cancel.isPending}
        onConfirm={(reason) => cancelling && cancel.mutate({ params: { id: cancelling.id }, body: { reason } })}
      />
      <ReasonDialog
        open={!!voiding}
        onClose={() => setVoiding(null)}
        kicker={voiding?.number ?? ''}
        title={`Void receipt · ${voiding?.studentName ?? ''}`}
        description={`Voiding reverses the allocation of ${formatINR(voiding?.amount ?? 0)}, posts a ledger reversal and recomputes fee clearance. Nothing is deleted.`}
        confirm={voiding?.voidNeedsApproval ? 'Request Super Admin approval' : 'Void receipt'}
        warn={voiding?.voidNeedsApproval ? 'This receipt is in a locked period — the void goes to a Super Admin for approval.' : null}
        loading={voidRec.isPending}
        onConfirm={(reason) => voiding && voidRec.mutate({ params: { id: voiding.id }, body: { reason } })}
      />
      <BulkDialog open={bulk} onClose={() => setBulk(false)} />
    </Page>
  );
}
