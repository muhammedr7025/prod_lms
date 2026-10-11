'use client';

import { DOCUMENT_PATHS, paymentsContract, type Order, type PayInfo } from '@exatech/contracts';
import { formatINR } from '@exatech/domain';
import { Button, Dialog, Field, Icon, Input, Issue, Kicker, Spinner, Tag } from '@exatech/ui';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMe } from '@/components/me-context';
import { ApiError, callApi } from '@/lib/api';
import { invalidatePrefixes, useApi } from '@/lib/hooks';
import { rupeesToPaise } from '../lib';
import { ChoiceSeg } from './parts';

type Purpose = 'next_due' | 'custom' | 'full';
type Phase = 'choose' | 'creating' | 'waiting' | 'paid' | 'failed';

interface Row {
  studentId: string;
  name: string;
  amount: number;
  orderId: string | null;
  checkoutUrl: string | null;
  status: 'queued' | 'waiting' | 'paid' | 'failed';
  receiptNumber: string | null;
  receiptId: string | null;
}

interface RazorpayCtor {
  new (opts: Record<string, unknown>): { open: () => void };
}

const POPUP = 'exa-pay';
const POPUP_FEATURES = 'popup,width=480,height=780';

/** Open (or reuse) the checkout window synchronously inside the click handler so it is not blocked. */
function openBlankPopup(): Window | null {
  const w = window.open('', POPUP, POPUP_FEATURES);
  if (w) {
    try {
      w.document.title = 'Pay now · Exatech';
      w.document.body.innerHTML = '<p style="font:15px system-ui;padding:24px;color:#1b2420">Opening secure checkout…</p>';
    } catch {
      /* already on the checkout origin */
    }
  }
  return w;
}

function loadRazorpay(): Promise<RazorpayCtor> {
  const existing = (window as unknown as { Razorpay?: RazorpayCtor }).Razorpay;
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => {
      const R = (window as unknown as { Razorpay?: RazorpayCtor }).Razorpay;
      if (R) resolve(R);
      else reject(new Error('Razorpay Checkout could not load — check your connection'));
    };
    s.onerror = () => reject(new Error('Razorpay Checkout could not load — check your connection'));
    document.body.appendChild(s);
  });
}

/**
 * Pay sheet (student & parent): Next due / Custom / Full → order → sandbox
 * checkout window (dev) or Razorpay Checkout → poll the order until the
 * webhook records it → success (checkmark, receipt, badge morph). With several
 * targets ("Pay for both children") it creates one order per child in turn.
 */
export function PaySheet({ open, onOpenChange, targets, all = false }: { open: boolean; onOpenChange: (o: boolean) => void; targets: PayInfo[]; all?: boolean }) {
  const me = useMe();
  const qc = useQueryClient();
  /** "Pay for both children": next due per child, one checkout each, with progress. */
  const multi = all || targets.length > 1;
  const first = targets[0];
  const [purpose, setPurpose] = useState<Purpose>('next_due');
  const [custom, setCustom] = useState('');
  const [phase, setPhase] = useState<Phase>('choose');
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [current, setCurrent] = useState(0);
  const popupRef = useRef<Window | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);

  // Fresh state every time the sheet opens.
  useEffect(() => {
    if (!open) return;
    setPurpose('next_due');
    setCustom('');
    setPhase('choose');
    setError(null);
    setRows([]);
    setCurrent(0);
    setPopupBlocked(false);
  }, [open]);

  const closePopup = () => {
    try {
      popupRef.current?.close();
    } catch {
      /* cross-origin */
    }
    popupRef.current = null;
  };

  const customPaise = rupeesToPaise(custom);
  const customError = (() => {
    if (purpose !== 'custom' || !first) return null;
    if (!custom.trim()) return 'Enter the amount to pay';
    if (customPaise == null) return 'Enter an amount in rupees';
    if (customPaise % 100 !== 0) return 'Pay in whole rupees';
    if (customPaise > first.full) return `At most ${formatINR(first.full)} is outstanding`;
    if (customPaise < first.minPartial && customPaise !== first.full) return `Minimum partial payment is ${formatINR(first.minPartial)}`;
    return null;
  })();
  const singleAmount = !first ? 0 : purpose === 'full' ? first.full : purpose === 'custom' ? (customPaise ?? 0) : first.nextDue;
  const total = multi ? targets.reduce((a, t) => a + t.nextDue, 0) : singleAmount;

  const startOrder = useCallback(
    async (list: Row[], i: number) => {
      const row = list[i]!;
      const body = multi || purpose === 'next_due' ? { studentId: row.studentId, purpose: 'next_due' as const } : purpose === 'full' ? { studentId: row.studentId, purpose: 'full' as const } : { studentId: row.studentId, purpose: 'custom' as const, amount: customPaise ?? 0 };
      let order: Order;
      try {
        order = await callApi(paymentsContract.createOrder, { body });
      } catch (e) {
        closePopup();
        setError(e instanceof ApiError ? e.message : 'Could not start the payment — try again');
        setRows((r) => r.map((x, k) => (k === i ? { ...x, status: 'failed' } : x)));
        setPhase(i === 0 ? 'choose' : 'failed');
        return;
      }
      setRows((r) => r.map((x, k) => (k === i ? { ...x, orderId: order.orderId, amount: order.amount, status: 'waiting', checkoutUrl: order.sandboxUrl } : x)));
      setCurrent(i);
      setPhase('waiting');
      if (order.gateway === 'sandbox' && order.sandboxUrl) {
        const w = popupRef.current && !popupRef.current.closed ? popupRef.current : window.open('', POPUP, POPUP_FEATURES);
        if (w) {
          popupRef.current = w;
          w.location.href = order.sandboxUrl;
          setPopupBlocked(false);
        } else setPopupBlocked(true);
      } else {
        closePopup();
        try {
          const R = await loadRazorpay();
          new R({
            key: order.keyId,
            order_id: order.externalOrderId,
            amount: order.amount,
            currency: 'INR',
            name: 'Exatech',
            description: order.description,
            prefill: { name: order.prefill.name, email: order.prefill.email ?? undefined, contact: order.prefill.contact ?? undefined },
            handler: (r: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => {
              callApi(paymentsContract.razorpayVerify, { params: { orderId: order.orderId }, body: r }).catch((e: unknown) => {
                setError(e instanceof ApiError ? e.message : 'The payment could not be verified');
                setPhase('failed');
              });
            },
            modal: { ondismiss: () => setPhase((p) => (p === 'waiting' ? 'failed' : p)) },
          }).open();
        } catch (e) {
          setError((e as Error).message);
          setPhase('failed');
        }
      }
    },
    [multi, purpose, customPaise],
  );

  const begin = () => {
    if (me.readOnly || !first) return;
    if (!multi && customError) return;
    setError(null);
    const list: Row[] = targets.map((t) => ({ studentId: t.studentId, name: t.studentName, amount: multi || purpose === 'next_due' ? t.nextDue : singleAmount, orderId: null, checkoutUrl: null, status: 'queued', receiptNumber: null, receiptId: null }));
    setRows(list);
    setPhase('creating');
    if (first.gateway === 'sandbox') {
      popupRef.current = openBlankPopup();
      setPopupBlocked(!popupRef.current);
    }
    void startOrder(list, 0);
  };

  // Poll the order being paid until the webhook records it.
  const watching = phase === 'waiting' ? rows[current]?.orderId : null;
  const status = useApi(paymentsContract.orderStatus, { params: { orderId: watching ?? '00000000-0000-0000-0000-000000000000' } }, { enabled: !!watching, refetchInterval: 1500 });
  const st = status.data;
  useEffect(() => {
    if (!st || !watching || st.orderId !== watching) return;
    if (st.status === 'paid') {
      const next = rows.map((x, k) => (k === current ? { ...x, status: 'paid' as const, receiptNumber: st.receiptNumber, receiptId: st.receiptId, amount: st.amount } : x));
      setRows(next);
      void invalidatePrefixes(qc, [['portal'], ['notifications']]);
      if (current + 1 < next.length) {
        setPhase('creating');
        void startOrder(next, current + 1);
      } else {
        closePopup();
        setPhase('paid');
      }
    } else if (st.status === 'failed' || st.status === 'expired') {
      setRows((r) => r.map((x, k) => (k === current ? { ...x, status: 'failed' } : x)));
      setError(st.status === 'expired' ? 'The checkout expired before the payment completed — no money was taken.' : 'The payment failed at the gateway — no money was taken. You can try again.');
      setPhase('failed');
    }
  }, [st?.status, st?.orderId, watching]); // eslint-disable-line react-hooks/exhaustive-deps

  const reopen = () => {
    const url = rows[current]?.checkoutUrl;
    if (!url) return;
    const w = window.open(url, POPUP, POPUP_FEATURES);
    popupRef.current = w;
    setPopupBlocked(!w);
  };

  const close = (o: boolean) => {
    if (!o) closePopup();
    onOpenChange(o);
  };

  if (!first) return null;
  const gatewayKicker = `Pay now · ${first.gatewayLabel}`;
  const paidTotal = rows.filter((r) => r.status === 'paid').reduce((a, r) => a + r.amount, 0);

  if (phase === 'paid') {
    return (
      <Dialog
        open={open}
        onOpenChange={close}
        kicker={`Paid · ${first.gatewayLabel}`}
        title={`${formatINR(paidTotal)} paid`}
        footer={
          <Button variant="primary" size="lg" onClick={() => close(false)}>
            Done
          </Button>
        }
      >
        <PaidView rows={rows} from={targets.some((t) => t.overdue) ? 'Overdue' : 'Due'} />
      </Dialog>
    );
  }

  if (phase === 'waiting' || phase === 'creating') {
    const row = rows[current];
    return (
      <Dialog
        open={open}
        onOpenChange={close}
        kicker={gatewayKicker}
        title={multi ? `Paying ${current + 1} of ${rows.length} · ${row?.name ?? ''}` : 'Waiting for payment…'}
        footer={
          <Button size="lg" onClick={() => close(false)}>
            Cancel
          </Button>
        }
      >
        <div className="text-sm opacity-85" data-testid="pay-waiting">
          {phase === 'creating' ? 'Creating a secure order…' : `Finish paying ${formatINR(row?.amount ?? 0)} for ${row?.name ?? ''} in the checkout window. This updates as soon as the gateway confirms — no need to refresh.`}
        </div>
        <div className="flex items-center gap-2 text-[13px] text-neutral-700">
          <Spinner /> {phase === 'creating' ? 'Preparing checkout' : 'Waiting for the payment webhook'}
        </div>
        {multi && <Progress rows={rows} current={current} />}
        {phase === 'waiting' && row?.checkoutUrl && (
          <div className="grid gap-1.5">
            {popupBlocked && <Issue kind="needed">Your browser blocked the checkout window — open it to continue</Issue>}
            <Button size="lg" onClick={reopen}>
              <Icon name="arrowRight" /> {popupBlocked ? 'Open checkout' : 'Reopen checkout'}
            </Button>
          </div>
        )}
      </Dialog>
    );
  }

  // choose | failed
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      kicker={gatewayKicker}
      title={multi ? `Pay for ${targets.length === 1 ? '1 child' : `${targets.length} children`} · ${formatINR(total)}` : first.title}
      footer={
        <>
          <Button size="lg" onClick={() => close(false)}>
            Later
          </Button>
          <Button variant="primary" size="lg" disabled={me.readOnly || (!multi && !!customError) || total <= 0} onClick={begin}>
            {phase === 'failed' ? `Retry · ${formatINR(total)}` : `Pay ${formatINR(total)}`}
          </Button>
        </>
      }
    >
      <div className="text-sm opacity-85">
        {multi
          ? `${targets.map((t) => `${t.firstName} · ${t.instalmentLabel.toLowerCase()} ${formatINR(t.nextDue)}`).join(' · ')}. One checkout per child, one after the other. Clearing a due instalment unlocks fee-gated notes immediately — access is recomputed on the payment webhook.`
          : `${first.studentName} · ${first.dueLine}. Clearing this unlocks fee-gated notes immediately — access is recomputed on the payment webhook.`}
      </div>
      {multi ? (
        <Progress rows={rows.length ? rows : targets.map((t) => ({ studentId: t.studentId, name: t.studentName, amount: t.nextDue, orderId: null, checkoutUrl: null, status: 'queued', receiptNumber: null, receiptId: null }))} current={-1} />
      ) : (
        <>
          <ChoiceSeg
            label="Amount"
            value={purpose}
            onChange={setPurpose}
            options={[
              { value: 'next_due', top: 'Next due', bottom: formatINR(first.nextDue) },
              { value: 'custom', top: 'Custom amount' },
              { value: 'full', top: 'Full', bottom: formatINR(first.full) },
            ]}
          />
          {purpose === 'custom' && (
            <Field label="Amount (₹)" error={custom.trim() ? customError : null} hint={`Minimum ${formatINR(first.minPartial)} (or the full ${formatINR(first.full)}) · whole rupees`}>
              <Input inputMode="numeric" autoFocus value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={String(first.nextDue / 100)} className="min-h-11" />
            </Field>
          )}
        </>
      )}
      <div className="flex gap-1.5 flex-wrap" aria-label="Payment methods">
        {['UPI', 'Card', 'Netbanking', 'Wallet'].map((m) => (
          <Tag key={m} variant="outline">
            {m}
          </Tag>
        ))}
      </div>
      {me.readOnly && <Issue kind="blocked">You are viewing as this user (read-only) — payments are blocked</Issue>}
      {error && <Issue kind="blocked">{error}</Issue>}
    </Dialog>
  );
}

function Progress({ rows, current }: { rows: Row[]; current: number }) {
  return (
    <div className="border border-divider" data-testid="pay-progress">
      {rows.map((r, i) => (
        <div key={r.studentId} className="flex justify-between items-center gap-2 px-3 py-2 min-h-11 border-b border-divider last:border-b-0 text-[13px]">
          <span className="min-w-0">
            <span className="font-medium">{r.name}</span>
            <span className="block text-xs text-neutral-600 tabular">
              {formatINR(r.amount)}
              {r.receiptNumber ? ` · ${r.receiptNumber}` : ''}
            </span>
          </span>
          <Tag variant={r.status === 'paid' ? 'accent' : r.status === 'failed' ? 'ink' : i === current ? 'outline' : 'neutral'}>
            {r.status === 'paid' ? 'Paid' : r.status === 'failed' ? 'Failed' : i === current ? 'Paying…' : 'Queued'}
          </Tag>
        </div>
      ))}
    </div>
  );
}

/** Checkmark draws on, receipt card slides up, fee badge morphs Overdue → Paid (400 ms; static under reduced motion). */
function PaidView({ rows, from }: { rows: Row[]; from: string }) {
  const reduce = useReducedMotion();
  const [morphed, setMorphed] = useState(!!reduce);
  useEffect(() => {
    if (reduce) return;
    const t = setTimeout(() => setMorphed(true), 450);
    return () => clearTimeout(t);
  }, [reduce]);
  const d = reduce ? 0 : 0.4;
  return (
    <div className="grid gap-3" data-testid="pay-success">
      <div className="flex items-center gap-3">
        <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden className="flex-none">
          <motion.circle cx="22" cy="22" r="20" fill="none" stroke="var(--color-accent)" strokeWidth="2" initial={{ pathLength: reduce ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: d }} />
          <motion.path d="M13 22.5l6 6 12-13" fill="none" stroke="var(--color-accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: reduce ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: d, delay: reduce ? 0 : 0.15 }} />
        </svg>
        <div className="min-w-0">
          <Kicker>Payment received</Kicker>
          <div className="text-[13px]">Fee status</div>
        </div>
        <span className="flex-1" />
        <span className="relative inline-grid" aria-live="polite">
          <AnimatePresence initial={false} mode="popLayout">
            {!morphed ? (
              <motion.span key="before" exit={{ opacity: 0, scale: 0.9 }} transition={{ duration: 0.2 }}>
                <Tag variant="ink">{from}</Tag>
              </motion.span>
            ) : (
              <motion.span key="paid" initial={reduce ? false : { opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.2 }}>
                <Tag variant="accent" data-testid="fee-badge">
                  Paid
                </Tag>
              </motion.span>
            )}
          </AnimatePresence>
        </span>
      </div>
      {rows
        .filter((r) => r.status === 'paid')
        .map((r, i) => (
          <motion.div
            key={r.studentId}
            initial={reduce ? false : { y: 16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: d, delay: reduce ? 0 : 0.1 + i * 0.08, ease: 'easeOut' }}
            className="relative border border-divider bg-surface p-3 grid gap-1"
            data-testid="pay-receipt"
          >
            <div className="flex justify-between gap-2 items-baseline">
              <span className="text-[13px] font-medium">{r.name}</span>
              <span className="font-heading font-semibold text-lg tabular">{formatINR(r.amount)}</span>
            </div>
            <div className="text-[13px]">
              Receipt <span className="font-mono text-xs">{r.receiptNumber ?? 'being issued…'}</span>
            </div>
            <div className="text-xs text-neutral-600">Receipt sent by WhatsApp + email · fee-gated notes unlock now</div>
            {r.receiptId && (
              <a href={DOCUMENT_PATHS.receipt(r.receiptId)} target="_blank" rel="noreferrer" className="text-[13px] text-accent-800 underline underline-offset-[3px] w-fit min-h-11 inline-flex items-center">
                Download receipt (PDF)
              </a>
            )}
          </motion.div>
        ))}
    </div>
  );
}

/** Hook: one pay sheet per screen. `open(pay)` for one child, `open([a, b])` for several. */
export function usePaySheet() {
  const [targets, setTargets] = useState<PayInfo[]>([]);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(false);
  const show = useCallback((t: PayInfo | PayInfo[] | null | undefined, opts: { all?: boolean } = {}) => {
    const list = (Array.isArray(t) ? t : t ? [t] : []).filter(Boolean);
    if (!list.length) return;
    setTargets(list);
    setAll(!!opts.all);
    setOpen(true);
  }, []);
  const element = <PaySheet open={open} onOpenChange={setOpen} targets={targets} all={all} />;
  return { open: show, element };
}
