'use client';

import { DENOMINATIONS, financeContract } from '@exatech/contracts';
import { formatINR } from '@exatech/domain';
import { Button, Card, CardTitle, EmptyState, Field, Input, Issue, Page, PageHeader, Row, Seg, Skeleton, Table, TableScroll, Tag, TD, TH } from '@exatech/ui';
import { useEffect, useMemo, useState } from 'react';
import { useApi, useApiMutation } from '@/lib/hooks';

const VALUE: Record<string, number> = { '500': 500_00, '200': 200_00, '100': 100_00, coins: 100 };
const LABEL: Record<string, string> = { '500': '₹500 ×', '200': '₹200 ×', '100': '₹100 ×', coins: 'Coins / small' };

/** Day book & cash closing — per counter, denominations, difference + explanation, close day / period locks. */
export function DayBookScreen() {
  const [branchId, setBranchId] = useState<string | undefined>(undefined);
  const q = useApi(financeContract.dayBook, { query: branchId ? { branchId } : {} }, { placeholderData: (p) => p });
  const d = q.data;
  const openCounters = useMemo(() => d?.counters.filter((c) => c.kind === 'counter' && c.open) ?? [], [d]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  useEffect(() => {
    if (!openCounters.some((c) => c.sessionId === sessionId)) setSessionId(openCounters[0]?.sessionId ?? null);
  }, [openCounters, sessionId]);
  const selected = openCounters.find((c) => c.sessionId === sessionId) ?? null;
  const [counts, setCounts] = useState<Record<string, string>>({ '500': '', '200': '', '100': '', coins: '' });
  const [explanation, setExplanation] = useState('');
  useEffect(() => {
    setCounts({ '500': '', '200': '', '100': '', coins: '' });
    setExplanation('');
  }, [sessionId]);
  const counted = DENOMINATIONS.reduce((a, k) => a + (Number(counts[k]) || 0) * VALUE[k]!, 0);
  const system = selected?.closingCash ?? 0;
  const difference = counted - system;
  const lastCounter = openCounters.length <= 1;
  const close = useApiMutation(financeContract.closeCounter, { invalidate: [['finance']], success: (r) => r.message });
  const lock = useApiMutation(financeContract.lockPeriod, { invalidate: [['finance']], success: 'Period locked · Super Admin to reopen' });
  const blocked = d?.dayClosed ? null : selected && difference !== 0 && explanation.trim().length < 5 ? `Counted ${formatINR(counted)} vs system ${formatINR(system)} — explain the ${formatINR(Math.abs(difference))} difference` : null;

  return (
    <Page label="Finance · Day book">
      <PageHeader
        kicker={d?.dateLabel ?? 'Day book'}
        title="Day book & cash closing"
        actions={
          <>
            {d && d.branches.length > 1 && <Seg aria-label="Branch" value={d.branchId} onChange={(v) => setBranchId(v)} options={d.branches.map((b) => ({ value: b.id, label: b.name }))} />}
            {d && <Tag variant={d.dayClosed ? 'accent' : 'outline'}>{d.statusLabel}</Tag>}
          </>
        }
      />
      {q.error && <EmptyState title="Could not load the day book" body={q.error.message} />}
      <Card pad="none">
        <TableScroll minWidth={900}>
          <Table>
            <thead>
              <tr>
                <TH>Counter · cashier</TH>
                <TH>Opened</TH>
                <TH className="text-right">Opening cash</TH>
                <TH className="text-right">UPI</TH>
                <TH className="text-right">Cash</TH>
                <TH className="text-right">Card</TH>
                <TH className="text-right">Cheque</TH>
                <TH className="text-right">Deposited</TH>
                <TH className="text-right">Closing cash</TH>
                <TH>Status</TH>
              </tr>
            </thead>
            <tbody>
              {!d &&
                Array.from({ length: 3 }, (_, i) => (
                  <tr key={i}>
                    <TD colSpan={10}>
                      <Skeleton className="h-6" />
                    </TD>
                  </tr>
                ))}
              {d?.counters.map((c) => {
                const m = (v: number | null) => (v === null ? '—' : formatINR(v));
                return (
                  <tr key={c.label}>
                    <TD className="font-medium">{c.label}</TD>
                    <TD>{c.opened}</TD>
                    <TD className="text-right tabular">{m(c.openingCash)}</TD>
                    <TD className="text-right tabular">{formatINR(c.upi)}</TD>
                    <TD className="text-right tabular">{m(c.cash)}</TD>
                    <TD className="text-right tabular">{formatINR(c.card)}</TD>
                    <TD className="text-right tabular">{m(c.cheque)}</TD>
                    <TD className="text-right tabular">{c.depositedLabel ?? m(c.deposited)}</TD>
                    <TD className="text-right tabular font-semibold">{m(c.closingCash)}</TD>
                    <TD>
                      <Tag variant={c.tag}>{c.statusLabel}</Tag>
                    </TD>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </TableScroll>
        {d && d.counters.filter((c) => c.kind === 'counter').length === 0 && <div className="px-4 py-3 text-[13px] text-neutral-600">No counter opened today · a cash session opens with the first desk payment.</div>}
      </Card>

      <div className="grid gap-3.5 items-start" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))' }}>
        <Card className="gap-2.5">
          <CardTitle>Denomination count{selected ? ` · ${selected.label.split(' · ')[0]}` : ''}</CardTitle>
          {openCounters.length > 1 && <Seg aria-label="Counter to count" value={sessionId ?? ''} onChange={(v) => setSessionId(v)} options={openCounters.map((c) => ({ value: c.sessionId!, label: c.label.split(' · ')[0]! }))} />}
          {d?.dayClosed ? (
            <Issue kind="ok">{d.dayClosedLabel ?? 'Day closed'} · desk entries for this day are locked</Issue>
          ) : selected ? (
            <>
              <Table>
                <tbody>
                  {DENOMINATIONS.map((k) => (
                    <tr key={k}>
                      <TD className="first:pl-0">{LABEL[k]}</TD>
                      <TD>
                        <Input aria-label={LABEL[k]} type="number" min={0} value={counts[k]} onChange={(e) => setCounts({ ...counts, [k]: e.target.value })} className="w-20 min-h-[30px] py-0.5 text-right" placeholder={k === 'coins' ? '₹' : '0'} />
                      </TD>
                      <TD className="text-right tabular">{formatINR((Number(counts[k]) || 0) * VALUE[k]!)}</TD>
                    </tr>
                  ))}
                  <tr>
                    <TD className="first:pl-0 font-semibold">Counted</TD>
                    <TD />
                    <TD className="text-right font-semibold tabular" data-testid="counted">
                      {formatINR(counted)}
                    </TD>
                  </tr>
                  <tr>
                    <TD className="first:pl-0">Difference vs system ({formatINR(system)})</TD>
                    <TD />
                    <TD className={`text-right font-semibold tabular ${difference === 0 ? 'text-accent-700' : 'text-ink'}`} data-testid="difference">
                      {formatINR(difference)}
                    </TD>
                  </tr>
                </tbody>
              </Table>
              <Field label="Explanation (required if difference ≠ 0)">
                <Input value={explanation} onChange={(e) => setExplanation(e.target.value)} placeholder="—" />
              </Field>
              {blocked && <Issue kind="blocked">{blocked}</Issue>}
            </>
          ) : (
            <div className="text-[13px] text-neutral-600">No open counter to count. {d && !d.dayClosed ? 'Closing the day locks desk entries for the rest of today.' : ''}</div>
          )}
          {d && !d.dayClosed && (
            <Button
              variant="primary"
              blueprint
              disabled={!!blocked}
              loading={close.isPending}
              onClick={() =>
                close.mutate({
                  body: {
                    branchId: d.branchId,
                    date: d.date,
                    sessionId: selected?.sessionId ?? null,
                    denominations: Object.fromEntries(DENOMINATIONS.map((k) => [k, k === 'coins' ? Math.round((Number(counts[k]) || 0)) : Number(counts[k]) || 0])),
                    explanation: explanation.trim() || undefined,
                  },
                })
              }
            >
              {selected && !lastCounter ? `Close ${selected.label.split(' · ')[0]}` : 'Close day · lock entries'}
            </Button>
          )}
        </Card>
        <Card className="gap-2.5">
          <CardTitle>Controls</CardTitle>
          <div className="grid gap-1.5 text-[13px]">
            {d?.controls.periodLocks.map((l) => (
              <Row key={l.month}>
                <span>{l.label}</span>
                <Tag variant={l.status === 'locked' ? 'accent' : 'outline'}>{l.note}</Tag>
              </Row>
            ))}
            {d?.controls.lockableMonth && (
              <Row>
                <span>{d.controls.lockableMonth.label}</span>
                <Button size="sm" loading={lock.isPending} onClick={() => lock.mutate({ body: { branchId: d.branchId, month: d.controls.lockableMonth!.month } })}>
                  Lock {d.controls.lockableMonth.label.split(' ')[0]}
                </Button>
              </Row>
            )}
            <Row>
              <span>Maker-checker</span>
              <span className="text-right">discounts, waivers, refunds, voids, restructures</span>
            </Row>
            <Row>
              <span>Voids today</span>
              <span className="text-right">{d?.controls.voidsToday ?? '—'}</span>
            </Row>
            <Row last>
              <span>Bank deposit due</span>
              <span className="text-right">{d?.controls.depositDue ?? '—'}</span>
            </Row>
          </div>
        </Card>
      </div>
    </Page>
  );
}
