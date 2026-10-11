'use client';

import { coreContract, DOCUMENT_PATHS, financeContract, paymentsContract } from '@exatech/contracts';
import { formatINR } from '@exatech/domain';
import { Button, Card, CardTitle, EmptyState, Issue, Kicker, Seg, Skeleton, Tag } from '@exatech/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useApi, useApiMutation } from '@/lib/hooks';

type Method = 'upi' | 'card' | 'netbanking' | 'wallet';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-surface grid justify-items-center content-start px-4 py-10">
      <div className="w-full max-w-[480px] grid gap-3.5 animate-rise">{children}</div>
    </main>
  );
}

function Success({ orderId, onHome }: { orderId: string; onHome: string }) {
  const st = useApi(paymentsContract.orderStatus, { params: { orderId } }, { refetchInterval: 2000 });
  const s = st.data;
  if (!s || s.status !== 'paid') {
    return (
      <Card className="gap-2.5 items-center text-center">
        <Kicker>Confirming with the gateway</Kicker>
        <CardTitle>Payment processing…</CardTitle>
        <div className="text-[13px] text-neutral-600">Your receipt appears as soon as the payment webhook is recorded.</div>
        <Skeleton className="h-4 w-40" />
      </Card>
    );
  }
  return (
    <Card tone="accent" className="gap-2.5" data-testid="checkout-success">
      <Kicker>Payment received</Kicker>
      <CardTitle className="text-[22px]">{formatINR(s.amount)} paid</CardTitle>
      <div className="text-[13px]">Receipt {s.receiptNumber}</div>
      <Tag variant={s.feeCleared ? 'accent' : 'ink'}>{s.feeCleared ? 'Fee cleared · notes unlocked' : 'Payment recorded · balance still due'}</Tag>
      <div className="flex gap-2 flex-wrap">
        {s.receiptId && (
          <a href={DOCUMENT_PATHS.receipt(s.receiptId)} target="_blank" rel="noreferrer">
            <Button>Download receipt</Button>
          </a>
        )}
        <Link href={onHome}>
          <Button variant="primary">Back to fees</Button>
        </Link>
      </div>
    </Card>
  );
}

/** Sandbox checkout (no Razorpay keys): looks like a checkout; Pay / Simulate failure post a signed webhook through the real handler. */
export function SandboxCheckout({ orderId }: { orderId: string }) {
  const q = useApi(financeContract.orderCheckout, { params: { orderId } });
  const me = useApi(coreContract.me, {});
  const [method, setMethod] = useState<Method>('upi');
  const [failed, setFailed] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);
  const pay = useApiMutation(paymentsContract.sandboxComplete, {
    invalidate: [['portal'], ['finance']],
    toastError: false,
    onSuccess: (r, a) => {
      if (a.body.outcome === 'failure' || r.status === 'failed') setFailed('Payment failed — no money was taken. You can try again.');
      else setPaid(true);
    },
    onError: (e) => setFailed(e.message),
  });
  const o = q.data;
  useEffect(() => {
    if (o?.status === 'paid') setPaid(true);
  }, [o?.status]);
  if (q.error) {
    return (
      <Shell>
        <EmptyState title="This payment link cannot be opened" body={q.error.status === 403 ? 'Sign in with the student or parent account this payment belongs to.' : q.error.message} action={<Link href="/"><Button>Go to the portal</Button></Link>} />
      </Shell>
    );
  }
  const home = me.data?.membership.roleKey === 'parent' ? '/parent/fees' : '/student/fees';
  return (
    <Shell>
      <div className="flex justify-between items-center">
        <Kicker>Pay now · {o?.gateway === 'sandbox' ? 'Sandbox checkout' : 'Razorpay'}</Kicker>
        <Tag variant="outline">Test mode · no real money</Tag>
      </div>
      {!o && <Skeleton className="h-72" />}
      {o && paid && <Success orderId={orderId} onHome={home} />}
      {o && !paid && (
        <Card className="gap-3" data-testid="sandbox-checkout">
          <div>
            <Kicker>{o.studentName}</Kicker>
            <CardTitle className="text-[28px] tabular">{formatINR(o.amount)}</CardTitle>
            <div className="text-[13px] text-neutral-700">{o.description}</div>
          </div>
          <div className="grid gap-1 text-[13px] border-t border-divider pt-2.5">
            <div className="flex justify-between">
              <span className="text-neutral-600">Payer</span>
              <span>{o.prefill.name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-600">Order</span>
              <span className="font-mono text-xs">{o.externalOrderId}</span>
            </div>
          </div>
          <Seg
            full
            size="lg"
            aria-label="Payment method"
            value={method}
            onChange={setMethod}
            options={[
              { value: 'upi', label: 'UPI' },
              { value: 'card', label: 'Card' },
              { value: 'netbanking', label: 'Netbanking' },
              { value: 'wallet', label: 'Wallet' },
            ]}
          />
          {failed && <Issue kind="blocked">{failed}</Issue>}
          <div className="flex gap-2">
            <Button size="lg" className="flex-1" disabled={pay.isPending} onClick={() => { setFailed(null); pay.mutate({ params: { orderId }, body: { outcome: 'failure', method } }); }}>
              Simulate failure
            </Button>
            <Button size="lg" variant="primary" blueprint className="flex-1" loading={pay.isPending} onClick={() => { setFailed(null); pay.mutate({ params: { orderId }, body: { outcome: 'success', method } }); }}>
              Pay {formatINR(o.amount)}
            </Button>
          </div>
          <div className="text-[11px] text-neutral-600">Clearing a due instalment unlocks fee-gated notes immediately — access is recomputed on the payment webhook.</div>
        </Card>
      )}
    </Shell>
  );
}

interface RazorpayCtor {
  new (opts: Record<string, unknown>): { open: () => void };
}

/** Razorpay Checkout for an order (used when Razorpay keys are configured); sandbox orders redirect to the sandbox page. */
export function RazorpayCheckout({ orderId }: { orderId: string }) {
  const router = useRouter();
  const q = useApi(financeContract.orderCheckout, { params: { orderId } });
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const verify = useApiMutation(paymentsContract.razorpayVerify, { invalidate: [['portal']], toastError: false, onSuccess: () => setDone(true), onError: (e) => setErr(e.message) });
  const o = q.data;
  useEffect(() => {
    if (o?.gateway === 'sandbox') router.replace(`/pay/sandbox/${orderId}`);
    if (o?.status === 'paid') setDone(true);
  }, [o, orderId, router]);
  const open = () => {
    if (!o) return;
    const go = () => {
      const R = (window as unknown as { Razorpay?: RazorpayCtor }).Razorpay;
      if (!R) return setErr('Razorpay Checkout could not load — check your connection');
      new R({
        key: o.keyId,
        order_id: o.externalOrderId,
        amount: o.amount,
        currency: 'INR',
        name: 'Exatech',
        description: o.description,
        prefill: { name: o.prefill.name, email: o.prefill.email ?? undefined, contact: o.prefill.contact ?? undefined },
        handler: (r: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => verify.mutate({ params: { orderId }, body: r }),
      }).open();
    };
    if ((window as unknown as { Razorpay?: unknown }).Razorpay) return go();
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = go;
    s.onerror = () => setErr('Razorpay Checkout could not load — check your connection');
    document.body.appendChild(s);
  };
  return (
    <Shell>
      <Kicker>Pay now · Razorpay</Kicker>
      {q.error && <EmptyState title="This payment link cannot be opened" body={q.error.message} />}
      {!o && !q.error && <Skeleton className="h-48" />}
      {o && done && <Success orderId={orderId} onHome="/" />}
      {o && !done && o.gateway === 'razorpay' && (
        <Card className="gap-3">
          <CardTitle className="text-[28px]">{formatINR(o.amount)}</CardTitle>
          <div className="text-[13px]">{o.description}</div>
          {err && <Issue kind="blocked">{err}</Issue>}
          <Button size="lg" variant="primary" blueprint loading={verify.isPending} onClick={open}>
            Pay {formatINR(o.amount)}
          </Button>
        </Card>
      )}
    </Shell>
  );
}
