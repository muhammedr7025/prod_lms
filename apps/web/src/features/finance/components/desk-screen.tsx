'use client';

import { financeContract, type DeskMatch, type FeeAccount, type PaymentResult, type TenderMethod } from '@exatech/contracts';
import { allocatePayment, formatDayMonth, formatINR, toISTTime } from '@exatech/domain';
import { Button, Card, CardTitle, Dialog, EmptyState, Field, Icon, Input, Issue, Kicker, Page, PageHeader, Select, Skeleton, Table, TableScroll, Tag, TD, TH } from '@exatech/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMe } from '@/components/me-context';
import { callApi } from '@/lib/api';
import { useApi, useApiMutation } from '@/lib/hooks';
import { newKey, openDoc, toPaise, toRupeeInput } from '../lib';

const COUNTER_KEY = 'exa.desk.counter';

interface TenderDraft {
  method: TenderMethod;
  amount: string;
  reference: string;
}

function referenceHint(acc: FeeAccount | undefined, method: TenderMethod): string | null {
  return acc?.methods.find((m) => m.method === method)?.referenceLabel ?? null;
}

/** Collection desk — scan or search, see dues, collect, print the receipt in under 30 seconds. */
export function DeskScreen() {
  const me = useMe();
  const params = useSearchParams();
  const preload = params.get('student');
  const [counter, setCounter] = useState('Counter 1');
  useEffect(() => {
    try {
      const saved = localStorage.getItem(COUNTER_KEY);
      if (saved) setCounter(saved);
    } catch {
      /* private mode */
    }
  }, []);
  const session = useApi(financeContract.deskSession, { query: { counter } });

  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<DeskMatch[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [enrollmentId, setEnrollmentId] = useState<string | null>(null);
  const account = useApi(financeContract.account, { params: { enrollmentId: enrollmentId ?? '00000000-0000-0000-0000-000000000000' } }, { enabled: !!enrollmentId });
  const acc = enrollmentId ? account.data : undefined;

  const [t1, setT1] = useState<TenderDraft>({ method: 'upi', amount: '', reference: '' });
  const [split, setSplit] = useState(false);
  const [t2, setT2] = useState<TenderDraft>({ method: 'cash', amount: '', reference: '' });
  const [done, setDone] = useState<PaymentResult | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const amount2Ref = useRef<HTMLInputElement>(null);
  const loadedFor = useRef<string | null>(null);

  // Prefill the collect form when an account opens.
  useEffect(() => {
    if (!acc || loadedFor.current === acc.enrollmentId) return;
    loadedFor.current = acc.enrollmentId;
    const first = acc.methods[0]?.method ?? 'cash';
    setT1({ method: first, amount: acc.suggestedAmount > 0 ? toRupeeInput(acc.suggestedAmount) : '', reference: '' });
    setT2({ method: acc.methods.find((m) => m.method === 'cash') ? 'cash' : first, amount: '', reference: '' });
    setSplit(false);
    setServerError(null);
    setTimeout(() => amountRef.current?.focus(), 30);
  }, [acc]);

  const open = useCallback((m: DeskMatch) => {
    setMatches(null);
    setSearchError(null);
    setDone(null);
    loadedFor.current = null;
    setEnrollmentId(m.enrollmentId);
  }, []);

  const runSearch = useCallback(
    async (q: { q?: string; studentId?: string }) => {
      setSearching(true);
      setSearchError(null);
      try {
        const r = await callApi(financeContract.deskSearch, { query: q });
        if (r.cardRejected) setSearchError('This card QR is not valid — the card may have been reissued');
        else if (r.items.length === 0) setSearchError(q.studentId ? 'No active fee account for this student in your branches' : `No student matches “${q.q}”`);
        else if (r.items.length === 1 || (r.items[0]!.exact && !r.items[1]?.exact)) open(r.items[0]!);
        else setMatches(r.items);
      } catch (e) {
        setSearchError((e as Error).message);
      } finally {
        setSearching(false);
      }
    },
    [open],
  );

  useEffect(() => {
    if (preload) void runSearch({ studentId: preload });
  }, [preload, runSearch]);

  const reset = useCallback(() => {
    setEnrollmentId(null);
    setMatches(null);
    setDone(null);
    setQuery('');
    setSearchError(null);
    setServerError(null);
    loadedFor.current = null;
    setTimeout(() => searchRef.current?.focus(), 30);
  }, []);

  // Tenders, totals and blocking reasons (the server re-validates).
  const tenders = useMemo(() => {
    const list = [t1, ...(split ? [t2] : [])];
    return list.map((t) => ({ method: t.method, amount: toPaise(t.amount) ?? 0, reference: t.reference.trim() || null }));
  }, [t1, t2, split]);
  const total = tenders.reduce((a, t) => a + t.amount, 0);
  const outstanding = acc?.outstanding ?? 0;
  const issues: string[] = [];
  if (acc) {
    if (total <= 0) issues.push('Enter the amount received');
    else if (tenders.some((t) => t.amount <= 0)) issues.push('Each tender needs a positive amount');
    else if (total < (acc.minPartial ?? 0) && total < outstanding) issues.push(`Minimum partial payment is ${formatINR(acc.minPartial)}`);
    for (const t of tenders) {
      const hint = referenceHint(acc, t.method);
      if (hint && !t.reference) issues.push(`Enter the ${hint}${split ? ` for the ${t.method === 'transfer' ? 'bank transfer' : t.method === 'upi' ? 'UPI' : t.method} tender` : ''}`);
    }
    if (split && t1.method === t2.method) issues.push('Pick two different methods for a split tender');
  }
  const mySession = session.data?.sessions.find((x) => (acc ? x.branchId === acc.branchId : true));
  const counterBlocked = mySession && (mySession.status === 'closed' ? `${counter} was closed at ${mySession.closedAt ? toISTTime(new Date(mySession.closedAt)) : ''} — pick another counter` : !mySession.cashierIsMe ? `${counter} is open under ${mySession.cashierName} — pick another counter` : null);
  const dayClosed = acc && session.data?.dayClosedBranches.includes(acc.branchId) ? `${acc.branchName}'s day book is closed for today — no more desk entries` : null;
  const blocked = dayClosed ?? counterBlocked ?? issues[0] ?? null;

  // One idempotency key per attempt: identical re-submits (double click, double Enter, retry) replay the same receipt.
  const key = useMemo(() => newKey(), [enrollmentId, JSON.stringify(tenders), counter]); // eslint-disable-line react-hooks/exhaustive-deps

  const collect = useApiMutation(financeContract.collect, {
    invalidate: [['finance'], ['students']],
    toastError: false,
    onSuccess: (r) => {
      setDone(r);
      setServerError(null);
    },
    onError: (e) => setServerError(e.message),
  });
  const resend = useApiMutation(financeContract.resendReceipt, { success: (r) => `Receipt sent again · ${r.sent} recipient${r.sent === 1 ? '' : 's'}` });

  const confirm = useCallback(() => {
    if (!acc || done || blocked || collect.isPending) return;
    collect.mutate({ body: { enrollmentId: acc.enrollmentId, tenders: tenders.map((t) => ({ method: t.method, amount: t.amount, reference: t.reference })), counterName: counter, idempotencyKey: key } });
  }, [acc, done, blocked, collect, tenders, counter, key]);

  // Keyboard: ⏎ confirm · F2 amount · F3 add tender · Esc reset.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        amountRef.current?.focus();
        amountRef.current?.select();
      } else if (e.key === 'F3') {
        e.preventDefault();
        if (acc && !done) {
          setSplit(true);
          setTimeout(() => amount2Ref.current?.focus(), 30);
        }
      } else if (e.key === 'Escape') {
        if (document.querySelector('[role="dialog"]')) return;
        e.preventDefault();
        reset();
      } else if (e.key === 'Enter' && acc && !done) {
        const t = e.target as HTMLElement;
        if (t.closest('[data-desk-search]') || t.tagName === 'BUTTON' || t.tagName === 'TEXTAREA' || document.querySelector('[role="dialog"]')) return;
        e.preventDefault();
        confirm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [acc, done, confirm, reset]);

  const changeCounter = (c: string) => {
    setCounter(c);
    try {
      localStorage.setItem(COUNTER_KEY, c);
    } catch {
      /* ignore */
    }
  };

  const kicker = (() => {
    const s = mySession;
    if (!s) return `${counter} · ${me.user.name} · cash session opens with the first payment`;
    if (s.status === 'closed') return `${counter} · ${s.cashierName} · closed ${s.closedAt ? toISTTime(new Date(s.closedAt)) : ''}`;
    return `${counter} · ${s.cashierName} · cash session open since ${toISTTime(new Date(s.openedAt))}`;
  })();

  // Allocation preview (oldest due first or by priority) — the server allocates the same way.
  const note = (() => {
    if (!acc) return '';
    if (done) return `Receipt ${done.receiptNumber} · ${done.feeCleared ? 'fee clearance: unlocked' : 'fee clearance: locked'}`;
    const items = acc.instalments.filter((i) => i.balance > 0).map((i) => ({ id: i.id, dueDate: i.dueDate, balance: i.balance, priority: i.seq }));
    const plan = allocatePayment(Math.max(0, total), items, acc.allocationOrder);
    const parts = plan.allocations.map((a) => `${acc.instalments.find((i) => i.id === a.id)?.label ?? ''} ${formatINR(a.amount)}`);
    const cheque = tenders.some((t) => t.method === 'cheque');
    return [
      parts.length ? `Allocated ${acc.allocationOrder === 'oldest_first' ? 'oldest due first' : 'by component priority'} → ${parts.join(', ')}` : null,
      plan.excess > 0 ? `${formatINR(plan.excess)} held as credit` : null,
      cheque ? 'Cheque stays pending clearance — notes unlock only after it clears' : null,
    ]
      .filter(Boolean)
      .join(' · ');
  })();
  const balanceAfter = done ? done.balanceAfter : Math.max(0, outstanding - total);
  const totalFmt = formatINR(done ? done.total : total);

  return (
    <Page label="Finance · Collection desk">
      <PageHeader
        kicker={kicker}
        title="Collection desk"
        actions={
          <>
            <Select aria-label="Counter" className="w-auto" value={counter} onChange={(e) => changeCounter(e.target.value)} options={session.data?.counters ?? ['Counter 1', 'Counter 2', 'Counter 3']} />
            <Tag variant="neutral">Keyboard: ⏎ confirm · F2 amount · F3 add tender</Tag>
          </>
        }
      />

      {!enrollmentId && (
        <Card pad="xl" className="items-center text-center !p-9 gap-3.5">
          <Icon name="scan" size={36} className="text-accent" />
          <CardTitle>Scan the admission barcode</CardTitle>
          <div className="text-[13px] opacity-80">or search by name, phone or admission number</div>
          <form
            data-desk-search
            className="flex gap-2 w-full max-w-[520px]"
            onSubmit={(e) => {
              e.preventDefault();
              if (query.trim()) void runSearch({ q: query.trim() });
            }}
          >
            <Input
              ref={searchRef}
              autoFocus
              aria-label="Scan or search"
              placeholder="Try “Anjali” or “Rohan” · TVM-FS-2027-00098"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setMatches(null);
                setSearchError(null);
              }}
              className="text-base min-h-11"
            />
            <Button type="submit" variant="primary" className="min-h-11" loading={searching}>
              Open
            </Button>
          </form>
          {searchError && <Issue kind="blocked">{searchError}</Issue>}
          {matches && (
            <div className="w-full max-w-[520px] grid gap-1.5 text-left" role="listbox" aria-label="Matching students">
              <Kicker>{matches.length} matches · pick one</Kicker>
              {matches.map((m) => (
                <button
                  key={m.enrollmentId}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => open(m)}
                  className="flex justify-between gap-3 items-center border border-divider bg-white px-3 py-2 text-[13px] hover:border-accent hover:bg-accent-100 cursor-pointer text-left"
                >
                  <span>
                    <b className="font-medium">{m.name}</b> · {m.admissionNo ?? 'no admission no.'}
                  </span>
                  <span className="text-neutral-600 text-xs">
                    {m.batchCode} · {m.branchName} · {m.phoneMasked}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="text-xs text-neutral-600">Works with any USB / Bluetooth scanner (keyboard wedge) or the phone camera in the PWA</div>
        </Card>
      )}

      {enrollmentId && (
        <div className="grid gap-3.5 items-start grid-cols-1 lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,1fr)]">
          <div className="grid gap-3.5 min-w-0">
            <Card className="gap-2.5 min-w-0">
              {!acc && !account.error && <Skeleton className="h-56" />}
              {account.error && <EmptyState title="Could not open this fee account" body={account.error.message} action={<Button onClick={reset}>Back to search</Button>} />}
              {acc && (
                <>
                  <div className="flex justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <Kicker>Fee account · {acc.batchLabel}</Kicker>
                      <CardTitle className="text-[22px]">{acc.studentName}</CardTitle>
                      <div className="text-[13px] text-neutral-700">
                        {acc.admissionNo ?? 'No admission no.'} · {acc.guardianLine}
                      </div>
                    </div>
                    <div className="grid gap-1 justify-items-end">
                      {acc.admissionNo && <img src={`${financeContract.barcodePath}?text=${encodeURIComponent(acc.admissionNo)}`} alt={`Barcode ${acc.admissionNo}`} width={150} height={30} className="h-[30px] w-[150px] object-fill" />}
                      <Tag variant={acc.clearance.tagVariant} data-testid="clearance-tag">
                        {acc.clearance.tag}
                      </Tag>
                    </div>
                  </div>
                  {acc.hasSchedule ? (
                    <TableScroll minWidth={560}>
                      <Table>
                        <thead>
                          <tr>
                            <TH>Instalment</TH>
                            <TH>Due</TH>
                            <TH>Amount</TH>
                            <TH>Paid</TH>
                            <TH>Balance</TH>
                            <TH>Status</TH>
                          </tr>
                        </thead>
                        <tbody>
                          {acc.instalments.map((r) => (
                            <tr key={r.id} className={r.suggested && !done ? 'bg-accent-100' : undefined} data-suggested={r.suggested || undefined}>
                              <TD className={r.suggested ? 'font-semibold' : undefined}>{r.label}</TD>
                              <TD>{formatDayMonth(r.dueDate)}</TD>
                              <TD className="tabular">{formatINR(r.amount)}</TD>
                              <TD className="tabular">{formatINR(r.paid + r.pendingPaid)}</TD>
                              <TD className={`tabular ${r.suggested ? 'font-semibold' : ''}`}>{formatINR(r.balance)}</TD>
                              <TD>
                                <Tag variant={r.tag}>{r.statusLabel}</Tag>
                              </TD>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    </TableScroll>
                  ) : (
                    <Issue kind="needed">
                      No fee schedule yet — <Link href={`/finance/accounts/${acc.enrollmentId}`} className="underline underline-offset-[3px]">set one up in the fee account (Restructure)</Link>
                    </Issue>
                  )}
                  <div className="flex justify-between gap-2.5 text-[13px]">
                    <span className="text-neutral-700">{acc.foot}</span>
                    <Link href={`/finance/accounts/${acc.enrollmentId}`} className="underline underline-offset-[3px] text-accent-800 whitespace-nowrap">
                      Full ledger
                    </Link>
                  </div>
                </>
              )}
            </Card>

            {done && (
              <Card tone="accent" className="gap-2.5 animate-rise" data-testid="receipt-card">
                <div className="flex justify-between items-center gap-2 flex-wrap">
                  <div className="flex gap-2.5 items-center">
                    <span className="w-7 h-7 bg-accent text-white grid place-items-center">
                      <Icon name="tick" size={16} />
                    </span>
                    <CardTitle>Receipt {done.receiptNumber}</CardTitle>
                  </div>
                  <Tag variant="accent">{done.status === 'pending_clearance' ? 'Sent · cheque pending clearance' : 'Sent · WhatsApp + email'}</Tag>
                </div>
                <div className="grid gap-2.5 text-[13px]" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
                  <div>
                    <Kicker>Received</Kicker>
                    {formatINR(done.total)}
                  </div>
                  <div>
                    <Kicker>Tenders</Kicker>
                    {done.tenderSummary}
                  </div>
                  <div>
                    <Kicker>Allocated to</Kicker>
                    {done.allocatedTo}
                  </div>
                  <div>
                    <Kicker>Balance now</Kicker>
                    {formatINR(done.balanceAfter)}
                  </div>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <Button onClick={() => openDoc(`/api/documents/receipts/${done.receiptId}.pdf?format=A4`)}>Print A4</Button>
                  <Button onClick={() => openDoc(`/api/documents/receipts/${done.receiptId}.pdf?format=A5`)}>Print A5</Button>
                  <Button onClick={() => openDoc(`/api/documents/receipts/${done.receiptId}.pdf?format=80mm`)}>Print 80 mm</Button>
                  <Button variant="ghost" loading={resend.isPending} onClick={() => resend.mutate({ params: { id: done.receiptId } })}>
                    Resend
                  </Button>
                  <div className="flex-1" />
                  <Button variant="primary" onClick={reset} autoFocus>
                    Next student
                  </Button>
                </div>
              </Card>
            )}
          </div>

          <Card tone="surface" className="gap-3" data-testid="collect-panel">
            <CardTitle>Collect</CardTitle>
            {!acc && <Skeleton className="h-72" />}
            {acc && (
              <>
                <Field label={`Amount (suggested: next due ${formatINR(acc.suggestedAmount)} · minimum ${formatINR(acc.minPartial)})`}>
                  <Input ref={amountRef} type="number" inputMode="numeric" min={0} step={1} tone="white" value={t1.amount} disabled={!!done} onChange={(e) => setT1({ ...t1, amount: e.target.value })} className="text-[22px] font-heading font-semibold min-h-[46px]" />
                </Field>
                <div className="grid grid-cols-2 gap-2.5">
                  <Field label="Method">
                    <Select tone="white" value={t1.method} disabled={!!done} onChange={(e) => setT1({ ...t1, method: e.target.value as TenderMethod, reference: '' })} options={acc.methods.map((m) => ({ value: m.method, label: m.label }))} />
                  </Field>
                  <Field label="Reference">
                    <Input tone="white" value={t1.reference} disabled={!!done || !referenceHint(acc, t1.method)} placeholder={referenceHint(acc, t1.method) ?? 'Not needed for cash'} onChange={(e) => setT1({ ...t1, reference: e.target.value })} />
                  </Field>
                </div>
                {split && (
                  <div className="grid grid-cols-2 gap-2.5 border-t border-divider pt-2.5">
                    <Field label="Second tender">
                      <Select tone="white" value={t2.method} disabled={!!done} onChange={(e) => setT2({ ...t2, method: e.target.value as TenderMethod, reference: '' })} options={acc.methods.map((m) => ({ value: m.method, label: m.label }))} />
                    </Field>
                    <Field label="Amount">
                      <Input ref={amount2Ref} type="number" inputMode="numeric" tone="white" value={t2.amount} disabled={!!done} onChange={(e) => setT2({ ...t2, amount: e.target.value })} />
                    </Field>
                    {referenceHint(acc, t2.method) && (
                      <Field label="Reference (second tender)" className="col-span-2">
                        <Input tone="white" value={t2.reference} disabled={!!done} placeholder={referenceHint(acc, t2.method)!} onChange={(e) => setT2({ ...t2, reference: e.target.value })} />
                      </Field>
                    )}
                  </div>
                )}
                <div className="flex gap-2 flex-wrap">
                  <Button className="flex-1" disabled={!!done} onClick={() => (split ? setSplit(false) : (setSplit(true), setTimeout(() => amount2Ref.current?.focus(), 30)))}>
                    {split ? 'Remove second tender' : 'Split tender (F3)'}
                  </Button>
                  <Button className="flex-1" disabled={!!done || total <= 0 || !acc.upiVpa} title={!acc.upiVpa ? 'Add the UPI VPA in Finance settings' : undefined} onClick={() => setQrOpen(true)}>
                    UPI QR for {totalFmt}
                  </Button>
                </div>
                {!acc.upiVpa && <div className="text-[11px] text-neutral-600 -mt-1">UPI QR needs the institution’s UPI ID — add it in Finance settings.</div>}
                <div className="flex justify-between text-[13px] border-t border-divider pt-2.5">
                  <span>Total received</span>
                  <b className="font-semibold tabular" data-testid="total-received">
                    {totalFmt}
                  </b>
                </div>
                <div className="flex justify-between text-[13px]">
                  <span>Balance after</span>
                  <b className="font-semibold tabular">{formatINR(balanceAfter)}</b>
                </div>
                {note && <div className="text-xs text-neutral-600">{note}</div>}
                {!done && blocked && (total > 0 || blocked === dayClosed || blocked === counterBlocked) && <Issue kind="blocked">{blocked}</Issue>}
                {!done && serverError && <Issue kind="blocked">{serverError}</Issue>}
                <Button variant="primary" blueprint className="min-h-[46px] text-base" disabled={!!done || !!blocked} loading={collect.isPending} onClick={confirm}>
                  Confirm &amp; print receipt ⏎
                </Button>
              </>
            )}
          </Card>
        </div>
      )}

      <Dialog
        open={qrOpen && !!acc}
        onOpenChange={setQrOpen}
        kicker="UPI · scan to pay"
        title={`${totalFmt} · ${acc?.studentName ?? ''}`}
        description={`Pay to ${acc?.upiVpa ?? ''} · note ${acc?.admissionNo ?? ''}. Enter the UPI transaction ID from the payer’s app as the reference, then confirm.`}
        center
        footer={<Button onClick={() => setQrOpen(false)}>Done</Button>}
      >
        {acc && total > 0 && <img src={`${financeContract.upiQrPath}?enrollmentId=${acc.enrollmentId}&amount=${total}`} alt="UPI QR code" width={220} height={220} className="mx-auto" />}
      </Dialog>
    </Page>
  );
}
