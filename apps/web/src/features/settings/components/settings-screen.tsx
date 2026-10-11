'use client';

import { BRAND_MIN_CONTRAST, BRAND_PRESETS, contrastOnWhite, institutionSettingsContract, type SettingsInput, type SettingsView } from '@exatech/contracts';
import { formatNumber, validatePattern } from '@exatech/domain';
import { Button, Card, CardBody, CardMeta, CardTitle, Checkbox, EmptyState, Field, Grid, Input, Issue, Page, PageHeader, Radio, Skeleton, Tag, cn } from '@exatech/ui';
import { useEffect, useMemo, useState } from 'react';
import { apiErrors, type FieldErrors } from '@/features/institution/components/parts';
import { useApi, useApiMutation } from '@/lib/hooks';

type Draft = Omit<SettingsInput, 'clearancePolicy'> & { policyKind: 'current_instalment' | 'fully_paid' | 'percentage'; policyPct: string };

const toDraft = (v: SettingsView): Draft => ({
  name: v.name,
  legalName: v.legalName,
  gstin: v.gstin,
  academicYearLabel: v.academicYearLabel,
  academicYearStart: v.academicYearStart,
  brandColor: v.brandColor,
  policyKind: v.clearancePolicy.kind,
  policyPct: v.clearancePolicy.kind === 'percentage' ? String(v.clearancePolicy.percentage) : '50',
  discountThresholds: { ...v.discountThresholds },
  admissionNumberPattern: v.admissionNumberPattern,
  security: { ...v.security, require2faRoles: [...v.security.require2faRoles] },
  leadRetentionMonths: v.leadRetentionMonths,
});

const toInput = (d: Draft): SettingsInput => ({
  name: d.name,
  legalName: d.legalName?.trim() ? d.legalName.trim() : null,
  gstin: d.gstin,
  academicYearLabel: d.academicYearLabel,
  academicYearStart: d.academicYearStart,
  brandColor: d.brandColor,
  clearancePolicy: d.policyKind === 'percentage' ? { kind: 'percentage', percentage: Number(d.policyPct) } : { kind: d.policyKind },
  discountThresholds: d.discountThresholds,
  admissionNumberPattern: d.admissionNumberPattern,
  security: d.security,
  leadRetentionMonths: d.leadRetentionMonths,
});

const num = (v: string) => (v.trim() === '' ? Number.NaN : Number(v));

/** Super Admin · Settings: identity & brand, fee-clearance default, discount thresholds, admission numbers, security. */
export function SettingsScreen() {
  const { data, isPending, error } = useApi(institutionSettingsContract.get, {});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  useEffect(() => {
    if (data) setDraft(toDraft(data));
  }, [data]);
  const save = useApiMutation(institutionSettingsContract.save, {
    invalidate: [['institution', 'settings'], ['me'], ['institution', 'roles']],
    success: 'Settings saved · applied across the app',
    toastError: false,
    onError: (e) => setErrors(apiErrors(e)),
    onSuccess: () => setErrors({}),
  });
  const dirty = useMemo(() => !!(data && draft && JSON.stringify(toInput(draft)) !== JSON.stringify(toInput(toDraft(data)))), [data, draft]);

  if (error) return <EmptyState title="Could not load settings" body={error.message} />;
  if (isPending || !draft || !data)
    return (
      <Page label="Super Admin · Settings">
        <PageHeader kicker="Institution" title="Settings" />
        <Grid min={320} gap={14}>
          {[0, 1, 2, 3].map((i) => (
            <Card key={i} pad="lg">
              <Skeleton className="h-48" />
            </Card>
          ))}
        </Grid>
      </Page>
    );

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const setSec = <K extends keyof Draft['security']>(k: K, v: Draft['security'][K]) => setDraft((d) => (d ? { ...d, security: { ...d.security, [k]: v } } : d));
  const submit = () => {
    setErrors({});
    save.mutate({ body: toInput(draft) });
  };

  const hexOk = /^#[0-9a-fA-F]{6}$/.test(draft.brandColor);
  const contrast = hexOk ? contrastOnWhite(draft.brandColor.toLowerCase()) : null;
  const pattern = validatePattern(draft.admissionNumberPattern);
  let preview: string | null = null;
  if (pattern.ok) {
    try {
      preview = formatNumber(draft.admissionNumberPattern, { BRANCH: data.preview.branchCode, COURSE: data.preview.courseCode, YEAR: data.preview.year, FY: data.preview.fy, SEQ: data.preview.nextSeq });
    } catch {
      preview = null;
    }
  }
  const disabled = !data.canManage;
  const e = (k: string) => errors[k];

  return (
    <Page label="Super Admin · Settings">
      <PageHeader
        kicker="Institution"
        title="Settings"
        actions={
          data.canManage && (
            <Button variant="primary" loading={save.isPending} disabled={!dirty} onClick={submit}>
              Save changes
            </Button>
          )
        }
      />
      {errors._ && Object.keys(errors).length === 1 && <Issue>{errors._}</Issue>}
      {Object.keys(errors).filter((k) => k !== '_').length > 0 && <Issue>Fix the highlighted fields — nothing was saved.</Issue>}

      <Grid min={320} gap={14}>
        <Card pad="lg" className="gap-3">
          <CardTitle>Identity</CardTitle>
          <Field label="Institution name" error={e('name')}>
            <Input value={draft.name} disabled={disabled} onChange={(ev) => set('name', ev.target.value)} />
          </Field>
          <Field label="Legal name" error={e('legalName')}>
            <Input value={draft.legalName ?? ''} disabled={disabled} onChange={(ev) => set('legalName', ev.target.value)} />
          </Field>
          <Field label="GSTIN" error={e('gstin')}>
            <Input value={draft.gstin} disabled={disabled} maxLength={15} onChange={(ev) => set('gstin', ev.target.value.toUpperCase())} />
          </Field>
          <div className="grid grid-cols-[1fr_1fr] gap-2.5">
            <Field label="Academic year" error={e('academicYearLabel')}>
              <Input value={draft.academicYearLabel} disabled={disabled} onChange={(ev) => set('academicYearLabel', ev.target.value)} placeholder="2026-27" />
            </Field>
            <Field label="Starts" error={e('academicYearStart')}>
              <Input type="date" value={draft.academicYearStart} disabled={disabled} onChange={(ev) => set('academicYearStart', ev.target.value)} />
            </Field>
          </div>
          <Field label="Brand colour (applied as primary token)" error={e('brandColor')}>
            <div className="grid gap-2">
              <div className="flex gap-2 flex-wrap items-center" role="radiogroup" aria-label="Brand colour presets">
                {BRAND_PRESETS.map((p) => {
                  const on = draft.brandColor.toLowerCase() === p.value;
                  return (
                    <button
                      key={p.value}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      aria-label={p.label}
                      title={`${p.label} · ${contrastOnWhite(p.value)}:1`}
                      disabled={disabled}
                      onClick={() => set('brandColor', p.value)}
                      className={cn('w-7 h-7 border-0 cursor-pointer disabled:cursor-not-allowed', on && 'outline-2 outline outline-offset-2')}
                      style={{ background: p.value, outlineColor: p.value }}
                    />
                  );
                })}
                <Input aria-label="Brand colour hex" value={draft.brandColor} disabled={disabled} onChange={(ev) => set('brandColor', ev.target.value.trim())} className="w-[110px] font-mono text-xs" maxLength={7} />
              </div>
              {contrast !== null && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="inline-flex items-center px-2.5 py-1 text-white font-heading font-semibold" style={{ background: draft.brandColor }}>
                    Button
                  </span>
                  <span className={contrast < BRAND_MIN_CONTRAST ? 'text-ink font-medium' : 'text-neutral-600'}>
                    White text {contrast}:1 · {contrast >= 4.5 ? 'AA for all text' : contrast >= BRAND_MIN_CONTRAST ? 'AA for buttons & large text' : `below ${BRAND_MIN_CONTRAST}:1 — pick a darker colour`}
                  </span>
                </div>
              )}
            </div>
          </Field>
        </Card>

        <Card pad="lg" className="gap-3">
          <CardTitle>Default fee clearance policy</CardTitle>
          <CardBody>Per course override allowed. Computed server-side, cached on the enrollment.</CardBody>
          <div className="grid gap-2" role="radiogroup" aria-label="Fee clearance policy">
            <Radio name="policy" checked={draft.policyKind === 'current_instalment'} onChange={() => set('policyKind', 'current_instalment')} label="Current instalment paid" />
            <Radio name="policy" checked={draft.policyKind === 'fully_paid'} onChange={() => set('policyKind', 'fully_paid')} label="Fully paid" />
            <Radio name="policy" checked={draft.policyKind === 'percentage'} onChange={() => set('policyKind', 'percentage')} label="Paid up to a percentage" />
            {draft.policyKind === 'percentage' && (
              <Field label="Minimum paid (% of the fee)" error={e('clearancePolicy.percentage')} className="max-w-[200px] ml-6">
                <Input inputMode="numeric" value={draft.policyPct} disabled={disabled} onChange={(ev) => set('policyPct', ev.target.value)} />
              </Field>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2.5 border-t border-divider pt-3">
            <Field label="Discount → Finance approval (%)" error={e('discountThresholds.financePct')}>
              <Input inputMode="numeric" value={Number.isNaN(draft.discountThresholds.financePct) ? '' : String(draft.discountThresholds.financePct)} disabled={disabled} onChange={(ev) => set('discountThresholds', { ...draft.discountThresholds, financePct: num(ev.target.value) })} />
            </Field>
            <Field label="Discount → Super Admin approval (%)" error={e('discountThresholds.superAdminPct')}>
              <Input inputMode="numeric" value={Number.isNaN(draft.discountThresholds.superAdminPct) ? '' : String(draft.discountThresholds.superAdminPct)} disabled={disabled} onChange={(ev) => set('discountThresholds', { ...draft.discountThresholds, superAdminPct: num(ev.target.value) })} />
            </Field>
          </div>
        </Card>

        <Card pad="lg" className="gap-3">
          <CardTitle>Admission number</CardTitle>
          <Field label="Format" error={e('admissionNumberPattern')} hint="Placeholders: {BRANCH} {COURSE} {YEAR} {FY} {SEQ:5}">
            <Input value={draft.admissionNumberPattern} disabled={disabled} onChange={(ev) => set('admissionNumberPattern', ev.target.value)} className="font-mono" />
          </Field>
          <div className="text-[13px] text-neutral-700" data-testid="admission-preview">
            {preview ? (
              <>
                Preview · <span className="font-mono">{preview}</span> <span className="text-xs text-neutral-500">(next {data.preview.branchCode} number)</span>
              </>
            ) : (
              <span className="text-ink font-medium">{pattern.reason ?? 'Pattern cannot be previewed'}</span>
            )}
          </div>
          <div className={cn('h-[34px]', !preview && 'opacity-30')} aria-hidden style={{ background: 'repeating-linear-gradient(90deg,#1b2420 0 2px,transparent 2px 4px,#1b2420 4px 5px,transparent 5px 8px,#1b2420 8px 11px,transparent 11px 13px)' }} />
          <CardMeta>Code 128 + signed QR token · printed on ID card, invoices, receipts</CardMeta>
        </Card>

        <Card pad="lg" className="gap-3">
          <CardTitle>Security</CardTitle>
          <Field label="Two-factor authentication required for" error={e('security.require2faRoles')}>
            <div className="grid grid-cols-2 gap-y-1.5 gap-x-3">
              {data.roles.map((r) => {
                const locked = data.locked2faRoles.includes(r.key);
                return (
                  <Checkbox
                    key={r.key}
                    disabled={disabled || locked}
                    checked={locked || draft.security.require2faRoles.includes(r.key)}
                    onChange={(on) => setSec('require2faRoles', on ? [...draft.security.require2faRoles, r.key] : draft.security.require2faRoles.filter((x) => x !== r.key))}
                    label={
                      <span>
                        {r.name}
                        {locked && (
                          <Tag variant="accent" size="sm" className="ml-1.5">
                            Mandatory
                          </Tag>
                        )}
                      </span>
                    }
                  />
                );
              })}
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-2.5 border-t border-divider pt-3">
            <Field label="Staff session (hours)" error={e('security.staffSessionHours')}>
              <Input inputMode="numeric" value={Number.isNaN(draft.security.staffSessionHours) ? '' : String(draft.security.staffSessionHours)} disabled={disabled} onChange={(ev) => setSec('staffSessionHours', num(ev.target.value))} />
            </Field>
            <Field label="Staff idle timeout (minutes)" error={e('security.staffIdleMinutes')}>
              <Input inputMode="numeric" value={Number.isNaN(draft.security.staffIdleMinutes) ? '' : String(draft.security.staffIdleMinutes)} disabled={disabled} onChange={(ev) => setSec('staffIdleMinutes', num(ev.target.value))} />
            </Field>
            <Field label="Student / parent session (days, rolling)" error={e('security.portalSessionDays')}>
              <Input inputMode="numeric" value={Number.isNaN(draft.security.portalSessionDays) ? '' : String(draft.security.portalSessionDays)} disabled={disabled} onChange={(ev) => setSec('portalSessionDays', num(ev.target.value))} />
            </Field>
            <Field label="View-as time box (minutes)" error={e('security.impersonationMinutes')}>
              <Input inputMode="numeric" value={Number.isNaN(draft.security.impersonationMinutes) ? '' : String(draft.security.impersonationMinutes)} disabled={disabled} onChange={(ev) => setSec('impersonationMinutes', num(ev.target.value))} />
            </Field>
            <Field label="Lead retention (months after last activity)" error={e('leadRetentionMonths')} className="col-span-2">
              <Input inputMode="numeric" value={Number.isNaN(draft.leadRetentionMonths) ? '' : String(draft.leadRetentionMonths)} disabled={disabled} onChange={(ev) => set('leadRetentionMonths', num(ev.target.value))} className="max-w-[160px]" />
            </Field>
          </div>
        </Card>
      </Grid>
    </Page>
  );
}
