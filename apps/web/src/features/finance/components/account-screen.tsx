'use client';

import { DOCUMENT_PATHS, financeContract, type FeeAccount } from '@exatech/contracts';
import { addDays, formatDayMonth, formatINR, todayIST } from '@exatech/domain';
import { Button, Card, CardHead, CardMeta, CardTitle, Dialog, EmptyState, Field, Grid, Input, Issue, Kicker, Mono, Page, PageHeader, Row, Skeleton, Stat, Table, TableScroll, Tag, TD, Textarea, TH, toast } from '@exatech/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useCan } from '@/components/me-context';
import { useApi, useApiMutation } from '@/lib/hooks';
import { openDoc, toPaise, toRupeeInput } from '../lib';

interface DraftRow {
  label: string;
  dueDate: string;
  amount: string;
}

function RestructureDialog({ acc, open, onClose }: { acc: FeeAccount; open: boolean; onClose: () => void }) {
  const target = acc.hasSchedule ? acc.instalments.reduce((a, i) => a + Math.max(0, i.amount - i.waived - i.paid - i.pendingPaid), 0) : null;
  const nextSeq = acc.instalments.reduce((m, i) => Math.max(m, i.seq), 0);
  const today = todayIST();
  const initial = (): DraftRow[] => {
    if (target === null) return [{ label: '1 · at admission', dueDate: today, amount: '' }];
    const half = Math.round(target / 2 / 100) * 100;
    return [
      { label: `${nextSeq + 1} · restructured`, dueDate: addDays(today, 14), amount: toRupeeInput(half) },
      { label: `${nextSeq + 2} · restructured`, dueDate: addDays(today, 45), amount: toRupeeInput(target - half) },
    ];
  };
  const [rows, setRows] = useState<DraftRow[]>(initial);
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) {
      setRows(initial());
      setReason('');
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const m = useApiMutation(financeContract.restructure, { invalidate: [['finance'], ['approvals']], success: (r) => r.message, onSuccess: onClose });
  const parsed = rows.map((r) => ({ label: r.label.trim(), dueDate: r.dueDate, amount: toPaise(r.amount) ?? 0 }));
  const sum = parsed.reduce((a, r) => a + r.amount, 0);
  const issues: string[] = [];
  if (parsed.some((r) => !r.label)) issues.push('Every row needs a label');
  if (parsed.some((r) => r.amount <= 0)) issues.push('Every row needs a positive amount');
  if (parsed.some((r) => !r.dueDate || r.dueDate < today)) issues.push('Due dates must be today or later');
  if (target !== null && sum !== target) issues.push(`Rows add up to ${formatINR(sum)} — they must equal the outstanding ${formatINR(target)}`);
  if (reason.trim().length < 5) issues.push('Give a reason (kept with the schedule history)');
  const needsApproval = (target ?? sum) > acc.restructureApprovalAbove;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={620}
      kicker={`${acc.studentName} · ${acc.hasSchedule ? `revision ${acc.revision} → ${acc.revision + 1}` : 'new fee schedule'}`}
      title={acc.hasSchedule ? 'Restructure balance' : 'Set up the fee schedule'}
      description={
        acc.hasSchedule
          ? `Split the outstanding ${formatINR(target ?? 0)} into new instalments. The current schedule is kept in history; unpaid parts of issued invoices are credit-noted.`
          : 'This enrollment has no instalments yet (e.g. imported at go-live). Enter the schedule — the rows become the fee account.'
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={issues.length > 0} loading={m.isPending} onClick={() => m.mutate({ params: { enrollmentId: acc.enrollmentId }, body: { rows: parsed, reason: reason.trim() } })}>
            {needsApproval ? 'Send for approval' : acc.hasSchedule ? 'Restructure' : 'Create schedule'}
          </Button>
        </>
      }
    >
      <div className="grid gap-2">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_150px_120px_auto] gap-2 items-end">
            <Field label={i === 0 ? 'Label' : ' '}>
              <Input value={r.label} aria-label={`Row ${i + 1} label`} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            </Field>
            <Field label={i === 0 ? 'Due date' : ' '}>
              <Input type="date" value={r.dueDate} min={today} aria-label={`Row ${i + 1} due date`} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)))} />
            </Field>
            <Field label={i === 0 ? 'Amount (₹)' : ' '}>
              <Input type="number" value={r.amount} aria-label={`Row ${i + 1} amount`} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
            </Field>
            <Button size="icon" variant="ghost" aria-label={`Remove row ${i + 1}`} disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              ×
            </Button>
          </div>
        ))}
        <div className="flex justify-between items-center">
          <Button size="sm" variant="ghost" disabled={rows.length >= 12} onClick={() => setRows([...rows, { label: `${nextSeq + rows.length + 1} · restructured`, dueDate: addDays(rows[rows.length - 1]?.dueDate ?? today, 30), amount: '' }])}>
            + Add row
          </Button>
          <span className="text-[13px] tabular">
            Total {formatINR(sum)}
            {target !== null && ` of ${formatINR(target)}`}
          </span>
        </div>
      </div>
      <Field label="Reason">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Parent requested two smaller instalments — salary date moved." className="min-h-[60px]" />
      </Field>
      {issues[0] && <Issue kind="blocked">{issues[0]}</Issue>}
      {issues.length === 0 && <Issue kind={needsApproval ? 'needed' : 'ok'}>{needsApproval ? `Above ${formatINR(acc.restructureApprovalAbove)} — another Finance Manager approves (maker-checker)` : 'Applies immediately'}</Issue>}
    </Dialog>
  );
}

function ExemptionDialog({ acc, open, onClose }: { acc: FeeAccount; open: boolean; onClose: () => void }) {
  const [until, setUntil] = useState(addDays(todayIST(), 14));
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) {
      setUntil(addDays(todayIST(), 14));
      setReason('');
    }
  }, [open]);
  const m = useApiMutation(financeContract.grantExemption, { invalidate: [['finance'], ['students']], success: `Exemption granted until ${formatDayMonth(until)}`, onSuccess: onClose });
  const blocked = until < todayIST() ? 'Pick a date from today onwards' : reason.trim().length < 5 ? 'A reason is required (at least 5 characters)' : null;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      kicker={`${acc.studentName} · fee clearance`}
      title="Grant a temporary exemption"
      description="Fee-gated notes stay unlocked until the date below even if an instalment is unpaid — e.g. a scholarship pending approval. Logged in the audit trail."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!!blocked} loading={m.isPending} onClick={() => m.mutate({ params: { enrollmentId: acc.enrollmentId }, body: { until, reason: reason.trim() } })}>
            Grant exemption
          </Button>
        </>
      }
    >
      <Field label="Exempt until">
        <Input type="date" value={until} min={todayIST()} onChange={(e) => setUntil(e.target.value)} />
      </Field>
      <Field label="Reason">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Scholarship decision due on 20 Oct" className="min-h-[60px]" />
      </Field>
      {blocked && <Issue kind="needed">{blocked}</Issue>}
    </Dialog>
  );
}

export function CallDialog({ enrollmentId, name, open, onClose }: { enrollmentId: string; name: string; open: boolean; onClose: () => void }) {
  const [outcome, setOutcome] = useState('');
  const [promise, setPromise] = useState('');
  useEffect(() => {
    if (open) {
      setOutcome('');
      setPromise('');
    }
  }, [open]);
  const m = useApiMutation(financeContract.logCall, { invalidate: [['finance']], success: promise ? `Call logged · promise-to-pay ${formatDayMonth(promise)}` : 'Call logged', onSuccess: onClose });
  const blocked = outcome.trim().length < 3 ? 'Note the outcome of the call' : promise && promise < todayIST() ? 'A promise-to-pay date cannot be in the past' : null;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      kicker={`${name} · follow-up`}
      title="Log call"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!!blocked} loading={m.isPending} onClick={() => m.mutate({ params: { enrollmentId }, body: { outcome: outcome.trim(), promiseDate: promise || null } })}>
            Log call
          </Button>
        </>
      }
    >
      <Field label="Outcome">
        <Textarea value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="Spoke to the parent — will pay after salary" className="min-h-[60px]" autoFocus />
      </Field>
      <Field label="Promise-to-pay date (optional)">
        <Input type="date" value={promise} min={todayIST()} onChange={(e) => setPromise(e.target.value)} />
      </Field>
      {blocked && outcome && <Issue kind="needed">{blocked}</Issue>}
    </Dialog>
  );
}

function RefundDialog({ acc, open, onClose }: { acc: FeeAccount; open: boolean; onClose: () => void }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) {
      setAmount('');
      setReason('');
    }
  }, [open]);
  const m = useApiMutation(financeContract.requestRefund, { invalidate: [['finance'], ['approvals']], success: (r) => r.message, onSuccess: onClose });
  const paise = toPaise(amount) ?? 0;
  const blocked = paise <= 0 ? 'Enter the refund amount' : paise > acc.paid ? `At most ${formatINR(acc.paid)} has been paid` : reason.trim().length < 5 ? 'Give the reason (policy window, drop-out…)' : null;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      kicker={`${acc.studentName} · refund`}
      title="Request a refund"
      description="Refunds always need Super Admin approval. On approval a credit note is issued and the payout is entered on the ledger."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!!blocked} loading={m.isPending} onClick={() => m.mutate({ params: { enrollmentId: acc.enrollmentId }, body: { amount: paise, reason: reason.trim() } })}>
            Send to Super Admin
          </Button>
        </>
      }
    >
      <Field label="Amount (₹)">
        <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <Field label="Reason">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Drop-out within the 14-day policy window" className="min-h-[60px]" />
      </Field>
      {blocked && amount && <Issue kind="needed">{blocked}</Issue>}
    </Dialog>
  );
}

/** Student fee account: totals, clearance, append-only ledger, schedule with revisions, follow-up. */
export function AccountScreen({ enrollmentId }: { enrollmentId: string }) {
  const q = useApi(financeContract.account, { params: { enrollmentId } });
  const canRestructure = useCan('finance:restructure');
  const canExempt = useCan('finance:exemption.grant');
  const canDues = useCan('finance:dues.manage');
  const canCollect = useCan('finance:payment.collect');
  const [dlg, setDlg] = useState<'restructure' | 'exempt' | 'call' | 'refund' | null>(null);
  const [link, setLink] = useState<{ url: string; description: string } | null>(null);
  const remind = useApiMutation(financeContract.remindAccount, { invalidate: [['finance']], success: 'Reminder sent · WhatsApp + email with the invoice PDF' });
  const payLink = useApiMutation(financeContract.paymentLink, {
    invalidate: [['finance']],
    onSuccess: async (r) => {
      setLink(r);
      try {
        await navigator.clipboard.writeText(r.url);
        toast('Payment link copied');
      } catch {
        /* clipboard blocked — the dialog shows the link */
      }
    },
  });
  const acc = q.data;
  if (q.error) return <Page label="Finance · Student fee account"><EmptyState title="Could not load this fee account" body={q.error.message} action={<Link href="/finance/accounts"><Button>Back to accounts</Button></Link>} /></Page>;
  if (!acc) {
    return (
      <Page label="Finance · Student fee account">
        <Skeleton className="h-14 w-80" />
        <Grid min={170}>{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[86px]" />)}</Grid>
        <Skeleton className="h-64" />
      </Page>
    );
  }
  const scheduleTag = (i: FeeAccount['instalments'][number]) => {
    if (i.state === 'overdue' || i.state === 'due_today') return { text: `${formatINR(i.balance)} ${i.state === 'overdue' ? 'overdue' : 'due today'}`, variant: 'ink' as const };
    return { text: i.statusLabel.replace(' · suggested', ''), variant: i.tag };
  };
  return (
    <Page label="Finance · Student fee account">
      <PageHeader
        kicker={`${acc.batchCode} · ${acc.courseName} · ${acc.admissionNo ?? 'no admission no.'}`}
        title={`${acc.studentName} · fee account`}
        actions={
          <>
            <Button onClick={() => openDoc(DOCUMENT_PATHS.statement(acc.enrollmentId))}>Statement of account</Button>
            {canRestructure && <Button onClick={() => setDlg('restructure')}>{acc.hasSchedule ? 'Restructure balance' : 'Set up fee schedule'}</Button>}
            {canCollect && (
              <Link href={`/finance/desk?student=${acc.studentId}`}>
                <Button variant="primary">Collect</Button>
              </Link>
            )}
          </>
        }
      />
      {acc.pendingApprovals.length > 0 && (
        <div className="grid gap-1">
          {acc.pendingApprovals.map((a) => (
            <Issue key={a.id} kind="needed">
              Awaiting approval · {a.title}
            </Issue>
          ))}
        </div>
      )}
      <Grid min={170}>
        <Stat size="md" label="Total fee" value={formatINR(acc.feeTotal)} meta={acc.planLabel} />
        <Stat size="md" label="Paid" value={formatINR(acc.paid)} meta={acc.pendingClearance > 0 ? `${acc.paidNote} · ${formatINR(acc.pendingClearance)} pending clearance` : acc.paidNote} />
        <Stat size="md" emphasis label="Overdue" value={formatINR(acc.overdue)} meta={acc.overdueNote} />
        <Card tone="white" pad="md" className="gap-0.5">
          <Kicker>Fee clearance</Kicker>
          <div className="font-heading font-semibold leading-[1.05] text-[28px]" data-testid="clearance-label">
            {acc.clearance.label}
          </div>
          <CardMeta className="flex-wrap">
            <span>{acc.clearance.exemptUntil && acc.clearance.exemptUntil >= todayIST() ? `Exempt until ${formatDayMonth(acc.clearance.exemptUntil)} · ${acc.clearance.exemptReason ?? ''}` : acc.clearance.reason}</span>
            {canExempt && (
              <>
                <span>·</span>
                <button type="button" className="underline underline-offset-[3px] text-accent-800 cursor-pointer" onClick={() => setDlg('exempt')}>
                  grant exemption
                </button>
              </>
            )}
          </CardMeta>
        </Card>
      </Grid>

      <Card pad="none">
        <CardHead>
          <CardTitle>Ledger · append-only</CardTitle>
          <Tag variant="neutral">Nothing is deleted — only reversed</Tag>
        </CardHead>
        <TableScroll minWidth={760}>
          <Table>
            <thead>
              <tr>
                <TH>Date</TH>
                <TH>Entry</TH>
                <TH>Reference</TH>
                <TH className="text-right">Debit</TH>
                <TH className="text-right">Credit</TH>
                <TH className="text-right">Balance</TH>
              </tr>
            </thead>
            <tbody>
              {acc.ledger.map((l) => (
                <tr key={l.id}>
                  <TD className="text-neutral-600 whitespace-nowrap">{formatDayMonth(l.date)}</TD>
                  <TD className={l.emphasis ? 'font-semibold' : undefined}>{l.entry}</TD>
                  <TD>
                    <Mono>{l.reference ?? '—'}</Mono>
                  </TD>
                  <TD className="text-right tabular">{l.debit ? formatINR(l.debit) : ''}</TD>
                  <TD className="text-right tabular text-accent-700">{l.credit ? formatINR(l.credit) : ''}</TD>
                  <TD className="text-right tabular font-medium">{formatINR(l.balance)}</TD>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableScroll>
        {acc.ledger.length === 0 && <EmptyState title="No entries yet" body="Charges post when invoices are issued; payments, credit notes and reversals follow." />}
      </Card>

      <Grid min={300}>
        <Card className="gap-2">
          <CardTitle>Instalment schedule · revision {acc.revision}</CardTitle>
          {!acc.hasSchedule && (
            <div className="grid gap-2 text-[13px]">
              <div>No fee schedule yet.</div>
              {canRestructure && (
                <Button size="sm" className="justify-self-start" onClick={() => setDlg('restructure')}>
                  Set up fee schedule
                </Button>
              )}
            </div>
          )}
          <div className="grid gap-1.5 text-[13px]">
            {acc.instalments.map((i, n) => {
              const t = scheduleTag(i);
              return (
                <Row key={i.id} last={n === acc.instalments.length - 1}>
                  <span>
                    {i.label} · {formatDayMonth(i.dueDate)}
                    {i.invoiceNumber && <span className="text-neutral-500 text-xs"> · {i.invoiceNumber.split('/').pop()}</span>}
                  </span>
                  <span className="whitespace-nowrap">
                    {formatINR(i.amount)} · <Tag variant={t.variant}>{t.text}</Tag>
                  </span>
                </Row>
              );
            })}
          </div>
          <CardMeta>Original schedule kept in history on restructure · approval needed above {formatINR(acc.restructureApprovalAbove)}</CardMeta>
        </Card>
        <Card className="gap-2">
          <CardTitle>Follow-up</CardTitle>
          <div className="text-[13px] grid gap-1.5">
            {acc.followUps.length === 0 && <div className="text-neutral-600">No reminders, calls or promises yet.</div>}
            {acc.followUps.map((f, n) => (
              <Row key={f.id} last={n === acc.followUps.length - 1 && !acc.promiseDate}>
                <span className="min-w-0">{f.label}</span>
                <span className="text-neutral-600 whitespace-nowrap">{formatDayMonth(f.date)}</span>
              </Row>
            ))}
            {acc.promiseDate && (
              <Row last>
                <span>Promise-to-pay</span>
                <Tag variant="outline">{formatDayMonth(acc.promiseDate)}</Tag>
              </Row>
            )}
          </div>
          {canDues && (
            <div className="flex gap-1.5 flex-wrap">
              <Button size="sm" loading={remind.isPending} disabled={acc.outstanding <= 0} onClick={() => remind.mutate({ params: { enrollmentId } })}>
                {acc.remindedToday ? 'Reminded · send again' : 'Send reminder'}
              </Button>
              <Button size="sm" onClick={() => setDlg('call')}>
                Log call
              </Button>
              <Button size="sm" variant="ghost" loading={payLink.isPending} disabled={acc.outstanding <= 0} onClick={() => payLink.mutate({ params: { enrollmentId } })}>
                Payment link
              </Button>
              {canCollect && acc.paid > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setDlg('refund')}>
                  Request refund
                </Button>
              )}
            </div>
          )}
          {acc.outstanding <= 0 && canDues && <div className="text-[11px] text-neutral-600">Nothing outstanding — reminders and payment links are off.</div>}
        </Card>
      </Grid>

      <RestructureDialog acc={acc} open={dlg === 'restructure'} onClose={() => setDlg(null)} />
      <ExemptionDialog acc={acc} open={dlg === 'exempt'} onClose={() => setDlg(null)} />
      <CallDialog enrollmentId={acc.enrollmentId} name={acc.studentName} open={dlg === 'call'} onClose={() => setDlg(null)} />
      <RefundDialog acc={acc} open={dlg === 'refund'} onClose={() => setDlg(null)} />
      <Dialog open={!!link} onOpenChange={(o) => !o && setLink(null)} kicker="Payment link · copied" title={link?.description ?? ''} description="Share it with the student or parent — it opens the portal checkout for this amount. Logged in the follow-up." footer={<Button variant="primary" onClick={() => setLink(null)}>Done</Button>}>
        <Input readOnly value={link?.url ?? ''} onFocus={(e) => e.currentTarget.select()} aria-label="Payment link" />
      </Dialog>
    </Page>
  );
}
