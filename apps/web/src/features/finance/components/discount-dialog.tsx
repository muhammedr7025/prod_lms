'use client';

import { financeContract, type FeeAccount } from '@exatech/contracts';
import { cumulativeDiscountPct, DISCOUNT_KINDS, DISCOUNT_KIND_LABEL, DISCOUNT_SOURCE_LABEL, discountApprovalLevel, formatINR, type DiscountKind } from '@exatech/domain';
import { Button, Dialog, Field, Input, Issue, Select, Seg, Tag, Textarea, toast } from '@exatech/ui';
import { useEffect, useState } from 'react';
import { useApiMutation } from '@/lib/hooks';
import { apiErrors, type FieldErrors } from '@/features/institution/components/parts';
import { toPaise } from '../lib';

const PLACEHOLDER: Record<DiscountKind, string> = {
  referral: 'Name or admission no. of the person who referred',
  scholarship: 'Trust, company or scheme',
  special: 'Who agreed to it',
  other: '',
};

/** Take an amount off a student's unpaid fee: referral, special discount, scholarship. Shows the effect before it is applied. */
export function DiscountDialog({ acc, open, onClose }: { acc: FeeAccount; open: boolean; onClose: () => void }) {
  const d = acc.discounts;
  const [kind, setKind] = useState<DiscountKind | ''>('');
  const [mode, setMode] = useState<'percent' | 'amount'>('percent');
  const [value, setValue] = useState('');
  const [source, setSource] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  useEffect(() => {
    if (open) {
      setKind('');
      setMode('percent');
      setValue('');
      setSource('');
      setReason('');
      setErrors({});
    }
  }, [open]);

  const m = useApiMutation(financeContract.grantDiscount, {
    invalidate: [['finance'], ['academics'], ['approvals']],
    toastError: false,
    onError: (e) => setErrors(apiErrors(e)),
    onSuccess: (r) => {
      onClose();
      toast(r.message, { durationMs: r.status === 'approval_requested' ? 8000 : 4500 });
    },
  });

  // Percent is of the list price (the same base the approval limits use), rounded to whole rupees.
  const num = Number(value.replace(/[₹,%\s]/g, ''));
  const amount = value.trim() === '' || !Number.isFinite(num) || num <= 0 ? 0 : mode === 'percent' ? Math.round((d.listTotal * num) / 100 / 100) * 100 : (toPaise(value) ?? 0);
  const feeAfter = acc.feeTotal - amount;
  const cum = cumulativeDiscountPct(d.listTotal, feeAfter);
  const level = discountApprovalLevel(cum, d.thresholds);
  const direct = cum <= d.directUpToPct;
  const tooMuch = amount > d.openPrincipal;
  const sourceLabel = kind ? DISCOUNT_SOURCE_LABEL[kind] : null;
  const blocked =
    !kind ? 'Choose why this discount is given'
    : amount <= 0 ? 'Enter how much to take off'
    : tooMuch ? `At most ${formatINR(d.openPrincipal)} can be taken off — the rest is already paid`
    : kind === 'referral' && !source.trim() ? 'Say who referred this student'
    : reason.trim().length < 5 ? 'Say why (at least 5 characters)'
    : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={560}
      kicker={`Fee account · ${acc.admissionNo ?? acc.studentName}`}
      title={`Give a discount · ${acc.studentName}`}
      description="Takes an amount off what is still unpaid, with the reason on record. It cannot go below what has already been paid — that would be a refund."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!!blocked}
            loading={m.isPending}
            onClick={() => m.mutate({ params: { enrollmentId: acc.enrollmentId }, body: { kind: kind as DiscountKind, amount, reason: reason.trim(), sourceName: source.trim() || null } })}
          >
            {direct ? 'Apply discount' : 'Send for approval'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3" data-testid="discount-dialog">
        {d.pctBelowList > 0 && (
          <div className="text-[12px] border border-divider bg-surface px-2.5 py-1.5">
            This fee is already <b className="font-medium">{d.pctBelowList}% below</b> the list price of {formatINR(d.listTotal)}. Approval limits count the <b className="font-medium">total</b> reduction, so earlier discounts are included.
          </div>
        )}
        <div className="grid sm:grid-cols-2 gap-2.5">
          <Field label="Why is it given?" error={errors.kind}>
            <Select value={kind} onChange={(e) => setKind(e.target.value as DiscountKind | '')} placeholder="Choose…" options={DISCOUNT_KINDS.map((k) => ({ value: k, label: DISCOUNT_KIND_LABEL[k] }))} />
          </Field>
          {sourceLabel && (
            <Field label={sourceLabel} error={errors.sourceName}>
              <Input value={source} onChange={(e) => setSource(e.target.value)} placeholder={kind ? PLACEHOLDER[kind] : ''} />
            </Field>
          )}
        </div>
        <div className="grid gap-1.5">
          <div className="flex items-end gap-2.5">
            <Field label={mode === 'percent' ? 'Percent of the list price' : 'Amount (₹)'} error={errors.amount} className="flex-1">
              <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder={mode === 'percent' ? 'e.g. 10' : 'e.g. 5000'} />
            </Field>
            <Seg
              aria-label="Enter as"
              value={mode}
              onChange={(v) => {
                setMode(v);
                setValue('');
              }}
              options={[
                { value: 'percent', label: '%' },
                { value: 'amount', label: '₹' },
              ]}
            />
          </div>
          <div className="text-[11px] text-neutral-600">Up to {formatINR(d.openPrincipal)} is still unpaid and can be reduced.</div>
        </div>
        <Field label="Reason" error={errors.reason}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this student gets it — it is shown on the fee account and in the discount report" className="min-h-[60px]" />
        </Field>

        {amount > 0 && !tooMuch && (
          <div className="border border-divider px-3 py-2.5 grid gap-1 text-[13px]" data-testid="discount-effect">
            <div className="flex justify-between">
              <span className="text-neutral-600">Taking off</span>
              <b className="font-medium tabular">{formatINR(amount)}</b>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-600">Fee</span>
              <span className="tabular">
                {formatINR(acc.feeTotal)} → <b className="font-medium">{formatINR(feeAfter)}</b>
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-600">Still to pay (before late fees)</span>
              <span className="tabular">
                {formatINR(d.openPrincipal)} → <b className="font-medium">{formatINR(d.openPrincipal - amount)}</b>
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-neutral-600">Total below the list price</span>
              <span className="flex items-center gap-1.5">
                <b className="font-medium tabular">{cum}%</b>
                {level === 'none' && <Tag variant="neutral">no approval needed</Tag>}
                {level === 'finance' && <Tag variant="neutral">Finance level (&gt;{d.thresholds.financePct}%)</Tag>}
                {level === 'super_admin' && <Tag variant="ink">Super Admin (&gt;{d.thresholds.superAdminPct}%)</Tag>}
              </span>
            </div>
          </div>
        )}
        {amount > 0 && !tooMuch && !direct && (
          <Issue kind="needed">This takes the total above {d.directUpToPct}% of the list price, so it goes to the Super Admin first. The fee changes only once it is approved.</Issue>
        )}
        {blocked && (kind || value || reason) && <Issue kind="blocked">{blocked}</Issue>}
      </div>
    </Dialog>
  );
}
