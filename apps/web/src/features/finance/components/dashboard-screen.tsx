'use client';

import { admissionsContract, financeContract, type AdmissionRow } from '@exatech/contracts';
import { formatINR, formatINRCompact, toISTTime } from '@exatech/domain';
import { Button, Card, CardHead, CardMeta, CardTitle, Dialog, EmptyState, Field, Grid, Page, PageHeader, Select, Skeleton, Stat, Sub, Table, TableScroll, Tag, TD, Textarea, TH, TR } from '@exatech/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useBranch, useCan } from '@/components/me-context';
import { useApi, useApiMutation } from '@/lib/hooks';
import { recentMonths } from '../lib';

function ReturnToSales({ row, onClose }: { row: AdmissionRow | null; onClose: () => void }) {
  const [note, setNote] = useState('');
  useEffect(() => setNote(''), [row]);
  const m = useApiMutation(admissionsContract.returnApp, { invalidate: [['admissions'], ['finance']], success: (r) => `Returned to Sales · ${r.studentName}`, onSuccess: onClose });
  if (!row) return null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      kicker={`${row.batchCode} · fee verification`}
      title={`Return ${row.studentName} to Sales`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} disabled={note.trim().length < 3} onClick={() => m.mutate({ params: { id: row.id }, body: { to: 'sales', note: note.trim() } })}>
            Return to Sales
          </Button>
        </>
      }
    >
      <Field label="Note for the salesperson" hint={note.trim().length < 3 ? 'A note is required so Sales knows what to fix' : undefined}>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Discount reason missing — attach the scholarship letter and resubmit." autoFocus />
      </Field>
    </Dialog>
  );
}

function ExportDialog({ kind, onClose }: { kind: 'gst' | 'tally' | null; onClose: () => void }) {
  const months = recentMonths(12);
  const [month, setMonth] = useState(months[0]!.value);
  if (!kind) return null;
  const href = `${kind === 'gst' ? financeContract.gstSummaryPath : financeContract.tallyExportPath}?month=${month}`;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      kicker={kind === 'gst' ? 'GST summary · CSV' : 'Export to Tally · CSV vouchers'}
      title={kind === 'gst' ? 'GST summary for filing' : 'Export vouchers to Tally'}
      description={kind === 'gst' ? 'Taxable value, CGST / SGST split (9 % + 9 %) and totals by SAC, with credit notes netted. The export is logged.' : 'Sales vouchers for invoices and Receipt vouchers per tender, ready for Tally import. The export is logged.'}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <a href={href} download onClick={() => setTimeout(onClose, 300)}>
            <Button variant="primary">Download CSV</Button>
          </a>
        </>
      }
    >
      <Field label="Month">
        <Select value={month} onChange={(e) => setMonth(e.target.value)} options={months} />
      </Field>
    </Dialog>
  );
}

/** Finance dashboard: KPIs, fee verification queue (step 2 of admission), method / ageing / target cards. */
export function FinanceDashboardScreen() {
  const { label: branchLabel } = useBranch();
  const dash = useApi(financeContract.dashboard, {}, { refetchInterval: 60_000 });
  const queue = useApi(admissionsContract.list, { query: { status: 'awaiting_finance' } });
  const canVerify = useCan('admissions:verify_fee');
  const [returning, setReturning] = useState<AdmissionRow | null>(null);
  const [exporting, setExporting] = useState<'gst' | 'tally' | null>(null);
  const verify = useApiMutation(admissionsContract.verifyFee, {
    invalidate: [['admissions'], ['finance'], ['approvals']],
    success: (r) => (r.needsSuperAdmin && !r.superAdminApproved ? `Fee terms verified · ${r.studentName} · discount sent to Super Admin` : `Fee terms verified · ${r.studentName} → Branch Admin`),
  });
  const d = dash.data;
  const items = queue.data?.items ?? [];
  const ap = d?.approvals;
  const extra = ap ? [ap.discounts ? `${ap.discounts} discount${ap.discounts === 1 ? '' : 's'}` : null, ap.refunds ? `${ap.refunds} refund${ap.refunds === 1 ? '' : 's'}` : null, ap.restructures ? `${ap.restructures} restructure${ap.restructures === 1 ? '' : 's'}` : null].filter(Boolean) : [];

  return (
    <Page label="Finance · Dashboard">
      <PageHeader
        kicker={`${branchLabel} · ${d?.todayLabel ?? ''}`}
        title="Finance"
        actions={
          <>
            <Button onClick={() => setExporting('gst')}>GST summary</Button>
            <Button onClick={() => setExporting('tally')}>Export to Tally</Button>
            <Link href="/finance/desk">
              <Button variant="primary">Collection desk</Button>
            </Link>
          </>
        }
      />
      {dash.error && <EmptyState title="Could not load the dashboard" body={dash.error.message} />}
      <Grid min={170}>
        {!d ? (
          Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[92px]" />)
        ) : (
          <>
            <Stat label="Collected today" value={formatINR(d.collectedToday.amount)} meta={`${d.collectedToday.receipts} receipt${d.collectedToday.receipts === 1 ? '' : 's'} · ${d.collectedToday.counters} counter${d.collectedToday.counters === 1 ? '' : 's'}`} />
            <Stat label="Expected this week" value={formatINRCompact(d.expectedWeek.amount)} meta={`${d.expectedWeek.instalments} instalment${d.expectedWeek.instalments === 1 ? '' : 's'} due ${d.expectedWeek.rangeLabel}`} />
            <Stat label="Overdue" value={formatINRCompact(d.overdue.amount)} meta={`${d.overdue.students} student${d.overdue.students === 1 ? '' : 's'} · ${d.overdue.promised} promised to pay`} />
            <Stat label="Pending clearance" value={formatINR(d.pendingClearance.amount)} meta={`${d.pendingClearance.cheques} cheque${d.pendingClearance.cheques === 1 ? '' : 's'} · ${d.pendingClearance.online} online pending`} />
            <Stat label="Fee verifications" value={queue.data ? items.length : '—'} meta={extra.length ? `+ ${extra.join(' · ')}` : 'No other approvals waiting'} />
          </>
        )}
      </Grid>

      <Card pad="none">
        <CardHead>
          <CardTitle>Fee verification queue · step 2 of admission</CardTitle>
          <Tag variant="neutral">Sales submits → you verify → Branch Admin approves</Tag>
        </CardHead>
        <TableScroll minWidth={860}>
          <Table>
            <thead>
              <tr>
                <TH>Applicant</TH>
                <TH>Batch</TH>
                <TH>Fee plan</TH>
                <TH>Discount</TH>
                <TH>Documents</TH>
                <TH>Salesperson</TH>
                <TH />
              </tr>
            </thead>
            <tbody>
              {queue.isPending &&
                Array.from({ length: 2 }, (_, i) => (
                  <tr key={i}>
                    <TD colSpan={7}>
                      <Skeleton className="h-6" />
                    </TD>
                  </tr>
                ))}
              {items.map((r) => (
                <TR key={r.id}>
                  <TD className="font-medium">
                    {r.studentName}
                    {r.returnedTo === 'finance' && r.returnNote && <Sub>Returned to Finance · {r.returnNote}</Sub>}
                  </TD>
                  <TD>{r.batchCode}</TD>
                  <TD className="text-xs">{r.planLine}</TD>
                  <TD>{r.discountPct ? `${r.discountPct}%` : '—'}</TD>
                  <TD>
                    <Tag variant={r.docs.uploaded >= r.docs.required ? 'outline' : 'ink'} title={r.docs.missing.length ? `Missing: ${r.docs.missing.join(', ')}` : undefined}>
                      {r.docs.uploaded}/{r.docs.required}
                    </Tag>
                  </TD>
                  <TD>{r.salesName}</TD>
                  <TD className="text-right whitespace-nowrap">
                    {canVerify && (
                      <>
                        <Button size="sm" onClick={() => setReturning(r)}>
                          Return to Sales
                        </Button>{' '}
                        <Button size="sm" variant="primary" loading={verify.isPending && verify.variables?.params.id === r.id} onClick={() => verify.mutate({ params: { id: r.id }, body: {} })}>
                          Verify fee terms
                        </Button>
                      </>
                    )}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableScroll>
        {queue.data && items.length === 0 && <div className="px-4 py-3.5 text-[13px] text-neutral-600">Queue is clear · new submissions from Sales land here first.</div>}
        {queue.error && <EmptyState title="Could not load the queue" body={queue.error.message} />}
      </Card>

      <Grid min={280}>
        <Card className="gap-2.5">
          <CardTitle>Today by method</CardTitle>
          {!d && <Skeleton className="h-24" />}
          {d?.byMethod.map((m) => (
            <div key={m.method} className="grid grid-cols-[70px_1fr_90px] gap-2.5 items-center text-[13px]">
              <span>{m.label}</span>
              <div className="h-3.5 bg-accent-100">
                <div className="h-full bg-accent" style={{ width: `${m.pct}%` }} />
              </div>
              <span className="text-right tabular">{formatINR(m.amount)}</span>
            </div>
          ))}
        </Card>
        <Card className="gap-2.5">
          <CardTitle>Dues by ageing</CardTitle>
          {!d && <Skeleton className="h-[120px]" />}
          {d && (
            <div className="grid grid-cols-4 gap-2 items-end h-[120px]">
              {d.ageing.map((a, i) => (
                <div key={a.bucket} className="grid gap-1 content-end text-center text-xs">
                  <span className="font-semibold">{formatINRCompact(a.amount)}</span>
                  <div className={['bg-accent-300', 'bg-accent-500', 'bg-accent-700', 'bg-ink'][i]} style={{ height: Math.round((a.heightPct / 100) * 70) }} />
                  <span className="text-neutral-600">{a.label}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card className="gap-2.5">
          <CardTitle>Collection vs target · {d?.targets.monthLabel ?? ''}</CardTitle>
          {!d && <Skeleton className="h-24" />}
          <div className="grid gap-2 text-[13px]">
            {d?.targets.rows.map((r) => (
              <div key={r.branchId} className="grid grid-cols-[90px_1fr_60px] gap-2.5 items-center" title={`${formatINR(r.collected)} of ${formatINR(r.target)}`}>
                <span>{r.branchName}</span>
                <div className="h-3.5 bg-accent-100">
                  <div className="h-full bg-accent" style={{ width: `${Math.min(100, r.pct)}%` }} />
                </div>
                <span className="text-right tabular">{r.pct}%</span>
              </div>
            ))}
          </div>
          {d && <CardMeta>{d.targets.paceNote}</CardMeta>}
        </Card>
      </Grid>
      {d && <div className="text-[11px] text-neutral-500 -mt-2">Figures refreshed {toISTTime(new Date(d.refreshedAt))} IST · cached up to 60 s, updated on every payment</div>}
      <ReturnToSales row={returning} onClose={() => setReturning(null)} />
      <ExportDialog kind={exporting} onClose={() => setExporting(null)} />
    </Page>
  );
}
