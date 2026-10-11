'use client';

import { DOCUMENT_PATHS, financeContract, type FinanceSettingsBody, type FinanceSettingsView } from '@exatech/contracts';
import { formatINR, formatNumber, validatePattern } from '@exatech/domain';
import { Button, Card, CardMeta, CardTitle, Checkbox, EmptyState, Field, Grid, Input, Issue, Page, PageHeader, Row, Select, Skeleton } from '@exatech/ui';
import { useEffect, useMemo, useState } from 'react';
import { useApi, useApiMutation } from '@/lib/hooks';
import { openDoc, toPaise, toRupeeInput } from '../lib';

interface Form {
  invoice: string;
  receipt: string;
  credit_note: string;
  gstRate: string;
  sac: string;
  graceDays: string;
  perDay: string;
  capPct: string;
  minPartial: string;
  allocationOrder: 'oldest_first' | 'component_priority';
  methods: FinanceSettingsView['methods'];
  upiVpa: string;
  before: string;
  after: string;
}

const METHOD_TAGS: { key: keyof FinanceSettingsView['methods']; label: string }[] = [
  { key: 'upi', label: 'UPI' },
  { key: 'cash', label: 'Cash' },
  { key: 'card', label: 'Card' },
  { key: 'cheque', label: 'Cheque · unlock after clearance' },
  { key: 'transfer', label: 'Bank transfer' },
  { key: 'online', label: 'Razorpay online' },
];

function toForm(s: FinanceSettingsView): Form {
  return {
    invoice: s.numbering.invoice,
    receipt: s.numbering.receipt,
    credit_note: s.numbering.credit_note,
    gstRate: String(s.gstRate),
    sac: s.sac,
    graceDays: String(s.lateFee.graceDays),
    perDay: toRupeeInput(s.lateFee.perDay),
    capPct: String(s.lateFee.capPct),
    minPartial: toRupeeInput(s.minPartial),
    allocationOrder: s.allocationOrder,
    methods: { ...s.methods },
    upiVpa: s.upiVpa ?? '',
    before: s.reminderDaysBefore.join(', '),
    after: s.reminderDaysAfter.join(', '),
  };
}

const days = (v: string) =>
  v
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map(Number);

/** Finance settings — numbering series, tax & late fee, thresholds, methods & allocation, templates. */
export function FinanceSettingsScreen() {
  const q = useApi(financeContract.settings, {});
  const [f, setF] = useState<Form | null>(null);
  useEffect(() => {
    if (q.data && !f) setF(toForm(q.data));
  }, [q.data, f]);
  const save = useApiMutation(financeContract.saveSettings, { invalidate: [['finance']], success: 'Finance settings saved', onSuccess: (r) => setF(toForm(r)) });
  const s = q.data;

  const errors = useMemo(() => {
    if (!f) return {} as Record<string, string>;
    const e: Record<string, string> = {};
    for (const k of ['invoice', 'receipt', 'credit_note'] as const) {
      const v = validatePattern(f[k]);
      if (!v.ok) e[k] = v.reason!;
    }
    const rate = Number(f.gstRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 28) e.gstRate = 'GST rate between 0 and 28 %';
    if (!/^\d{4,8}$/.test(f.sac.trim())) e.sac = 'SAC is 4–8 digits';
    if (!Number.isInteger(Number(f.graceDays)) || Number(f.graceDays) < 0) e.graceDays = 'Whole days, 0 or more';
    if (toPaise(f.perDay) === null) e.perDay = 'Enter a rupee amount';
    if (!(Number(f.capPct) >= 0 && Number(f.capPct) <= 100)) e.capPct = '0–100 %';
    if (toPaise(f.minPartial) === null) e.minPartial = 'Enter a rupee amount';
    if (f.upiVpa.trim() && !/^[\w.-]{2,256}@[a-zA-Z]{2,64}$/.test(f.upiVpa.trim())) e.upiVpa = 'Enter a UPI ID like exatech@icici';
    if (days(f.before).some((x) => !Number.isInteger(x) || x < 0 || x > 60)) e.before = 'Days 0–60, comma separated';
    if (days(f.after).some((x) => !Number.isInteger(x) || x < 1 || x > 120)) e.after = 'Days 1–120, comma separated';
    if (!(['upi', 'cash', 'card', 'cheque', 'transfer'] as const).some((m) => f.methods[m])) e.methods = 'Keep at least one desk method on';
    return e;
  }, [f]);

  const preview = (pattern: string, seq: number) => {
    if (!s) return '';
    try {
      return formatNumber(pattern, { BRANCH: s.preview.branchCode, FY: s.preview.fy, SEQ: seq, YEAR: s.preview.fy.slice(0, 4), COURSE: 'DM' });
    } catch {
      return '—';
    }
  };

  const submit = () => {
    if (!f || Object.keys(errors).length) return;
    const body: FinanceSettingsBody = {
      numbering: { invoice: f.invoice.trim(), receipt: f.receipt.trim(), credit_note: f.credit_note.trim() },
      gstRate: Number(f.gstRate),
      sac: f.sac.trim(),
      lateFee: { graceDays: Number(f.graceDays), perDay: toPaise(f.perDay)!, capPct: Number(f.capPct) },
      minPartial: toPaise(f.minPartial)!,
      allocationOrder: f.allocationOrder,
      methods: f.methods,
      upiVpa: f.upiVpa.trim() || null,
      reminderDaysBefore: days(f.before),
      reminderDaysAfter: days(f.after),
    };
    save.mutate({ body });
  };

  if (q.error) return <Page label="Finance · Settings"><EmptyState title="Could not load finance settings" body={q.error.message} /></Page>;
  return (
    <Page label="Finance · Settings">
      <PageHeader
        kicker="Module settings · per institution and branch"
        title="Finance settings"
        actions={
          <Button variant="primary" disabled={!f || Object.keys(errors).length > 0} loading={save.isPending} onClick={submit}>
            Save
          </Button>
        }
      />
      {!f || !s ? (
        <Grid min={300}>{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-56" />)}</Grid>
      ) : (
        <Grid min={300}>
          <Card className="gap-2.5">
            <CardTitle>Numbering series</CardTitle>
            <Field label="Invoice" error={errors.invoice} hint={`Next: ${preview(f.invoice, s.preview.invoiceSeq)}`}>
              <Input value={f.invoice} onChange={(e) => setF({ ...f, invoice: e.target.value })} />
            </Field>
            <Field label="Receipt" error={errors.receipt} hint={`Next: ${preview(f.receipt, s.preview.receiptSeq)}`}>
              <Input value={f.receipt} onChange={(e) => setF({ ...f, receipt: e.target.value })} />
            </Field>
            <Field label="Credit note" error={errors.credit_note} hint={`Next: ${preview(f.credit_note, s.preview.creditNoteSeq)}`}>
              <Input value={f.credit_note} onChange={(e) => setF({ ...f, credit_note: e.target.value })} />
            </Field>
            <CardMeta>Sequential, gap-free, per branch per financial year</CardMeta>
          </Card>
          <Card className="gap-2.5">
            <CardTitle>Tax &amp; late fee</CardTitle>
            <div className="grid grid-cols-2 gap-2.5">
              <Field label="GST rate (%)" error={errors.gstRate}>
                <Input type="number" value={f.gstRate} onChange={(e) => setF({ ...f, gstRate: e.target.value })} />
              </Field>
              <Field label="SAC" error={errors.sac}>
                <Input value={f.sac} onChange={(e) => setF({ ...f, sac: e.target.value })} />
              </Field>
              <Field label="Grace period (days)" error={errors.graceDays}>
                <Input type="number" value={f.graceDays} onChange={(e) => setF({ ...f, graceDays: e.target.value })} />
              </Field>
              <Field label="Late fee (₹ / day on unpaid balance)" error={errors.perDay}>
                <Input type="number" value={f.perDay} onChange={(e) => setF({ ...f, perDay: e.target.value })} />
              </Field>
              <Field label="Cap (% of instalment)" error={errors.capPct}>
                <Input type="number" value={f.capPct} onChange={(e) => setF({ ...f, capPct: e.target.value })} />
              </Field>
            </div>
            <CardMeta>
              CGST {Number(f.gstRate) / 2}% + SGST {Number(f.gstRate) / 2}% on every invoice · late fee {formatINR(toPaise(f.perDay) ?? 0)}/day after {f.graceDays} days, capped at {f.capPct}%
            </CardMeta>
          </Card>
          <Card className="gap-2.5">
            <CardTitle>Approval thresholds</CardTitle>
            <div className="grid gap-1.5 text-[13px]">
              <Row>
                <span>Discount &gt; {s.discountThresholds.financePct}%</span>
                <span>Finance Manager</span>
              </Row>
              <Row>
                <span>Discount &gt; {s.discountThresholds.superAdminPct}%</span>
                <span>Super Admin</span>
              </Row>
              <Row>
                <span>Refund any</span>
                <span>Super Admin + reason</span>
              </Row>
              <Row>
                <span>Void in a locked period</span>
                <span>Super Admin</span>
              </Row>
              <Row last>
                <span>Restructure &gt; {formatINR(s.restructureApprovalAbove)}</span>
                <span>Finance Manager (maker-checker)</span>
              </Row>
            </div>
            <CardMeta>Thresholds are set by the Super Admin in institution settings</CardMeta>
          </Card>
          <Card className="gap-2.5">
            <CardTitle>Payment methods &amp; allocation</CardTitle>
            <div className="flex gap-x-4 gap-y-2 flex-wrap">
              {METHOD_TAGS.map((m) => (
                <Checkbox key={m.key} checked={f.methods[m.key]} onChange={(v) => setF({ ...f, methods: { ...f.methods, [m.key]: v } })} label={m.label} />
              ))}
            </div>
            {errors.methods && <Issue kind="blocked">{errors.methods}</Issue>}
            <Field label="Allocation order">
              <Select
                value={f.allocationOrder}
                onChange={(e) => setF({ ...f, allocationOrder: e.target.value as Form['allocationOrder'] })}
                options={[
                  { value: 'oldest_first', label: 'Oldest due first' },
                  { value: 'component_priority', label: 'Component priority (registration, tax first)' },
                ]}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2.5">
              <Field label="Minimum partial payment (₹)" error={errors.minPartial}>
                <Input type="number" value={f.minPartial} onChange={(e) => setF({ ...f, minPartial: e.target.value })} />
              </Field>
              <Field label="UPI VPA (desk QR)" error={errors.upiVpa}>
                <Input value={f.upiVpa} placeholder="exatech@icici" onChange={(e) => setF({ ...f, upiVpa: e.target.value })} />
              </Field>
              <Field label="Remind days before due" error={errors.before}>
                <Input value={f.before} onChange={(e) => setF({ ...f, before: e.target.value })} placeholder="3" />
              </Field>
              <Field label="Remind days after due" error={errors.after}>
                <Input value={f.after} onChange={(e) => setF({ ...f, after: e.target.value })} placeholder="1, 4, 8" />
              </Field>
            </div>
            <CardMeta>Reminders run daily at 09:00 IST, skip holidays and stop once paid</CardMeta>
          </Card>
          <Card className="gap-2.5">
            <CardTitle>Document templates</CardTitle>
            <div className="grid gap-1.5 text-[13px]">
              <Row>
                <span>GST tax invoice · A4</span>
                <button type="button" className="underline underline-offset-[3px] text-accent-800 cursor-pointer disabled:opacity-40" disabled={!s.samples.invoiceId} onClick={() => s.samples.invoiceId && openDoc(DOCUMENT_PATHS.invoice(s.samples.invoiceId))}>
                  Preview
                </button>
              </Row>
              <Row>
                <span>Receipt · A4 / A5 / 80 mm</span>
                <span className="flex gap-2">
                  {(['A4', 'A5', '80mm'] as const).map((fmt) => (
                    <button key={fmt} type="button" className="underline underline-offset-[3px] text-accent-800 cursor-pointer disabled:opacity-40" disabled={!s.samples.receiptId} onClick={() => s.samples.receiptId && openDoc(`${DOCUMENT_PATHS.receipt(s.samples.receiptId)}?format=${fmt}`)}>
                      {fmt === '80mm' ? '80 mm' : fmt}
                    </button>
                  ))}
                </span>
              </Row>
              <Row last>
                <span>Statement of account</span>
                <button type="button" className="underline underline-offset-[3px] text-accent-800 cursor-pointer disabled:opacity-40" disabled={!s.samples.enrollmentId} onClick={() => s.samples.enrollmentId && openDoc(DOCUMENT_PATHS.statement(s.samples.enrollmentId))}>
                  Preview
                </button>
              </Row>
            </div>
            <CardMeta>Logo, GSTIN, admission barcode, verification QR and cashier are injected automatically</CardMeta>
          </Card>
        </Grid>
      )}
      {save.error && <Issue kind="blocked">{save.error.message}</Issue>}
    </Page>
  );
}
