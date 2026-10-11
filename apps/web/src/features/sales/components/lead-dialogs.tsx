'use client';

import { LOST_REASONS, salesContract, type LeadDetail } from '@exatech/contracts';
import { Button, buttonVariants, Checkbox, Dialog, Field, Input, Issue, Select, Textarea } from '@exatech/ui';
import { useEffect, useMemo, useState } from 'react';
import { useApi, useApiMutation } from '@/lib/hooks';
import { fillTemplate, waHref } from '../lib';

/** "Log call" outcome after tapping Call. */
export function LogCallDialog({ lead, open, onOpenChange }: { lead: LeadDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [summary, setSummary] = useState('');
  const [consent, setConsent] = useState(false);
  useEffect(() => {
    if (open) {
      setSummary('');
      setConsent(!lead.consentWhatsapp);
    }
  }, [open, lead.consentWhatsapp]);
  const log = useApiMutation(salesContract.logActivity, { invalidate: [['sales']], success: 'Call logged', onSuccess: () => onOpenChange(false) });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      kicker={`Call · ${lead.phoneDisplay}`}
      title={`Log call · ${lead.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={log.isPending} disabled={summary.trim().length < 2} onClick={() => log.mutate({ params: { id: lead.id }, body: { kind: 'call', summary: summary.trim(), ...(consent && !lead.consentWhatsapp ? { consentWhatsapp: true } : {}) } })}>
            Save outcome
          </Button>
        </>
      }
    >
      <Field label="Outcome" hint="e.g. 6 min · interested, asked about EMI">
        <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What happened on the call?" autoFocus />
      </Field>
      {!lead.consentWhatsapp && <Checkbox checked={consent} onChange={setConsent} label="Lead agreed to WhatsApp updates (consent captured on this call)" />}
      {!lead.firstResponseAt && <div className="text-xs text-neutral-600">This is the first contact — it stops the first-response timer.</div>}
    </Dialog>
  );
}

/** WhatsApp with an approved template: fill variables, open wa.me, log the activity. */
export function WhatsAppDialog({ lead, open, onOpenChange }: { lead: LeadDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const templates = useApi(salesContract.templates, {}, { enabled: open, staleTime: 5 * 60_000 });
  const approved = useMemo(() => (templates.data ?? []).filter((t) => t.status === 'approved' && t.channel === 'whatsapp'), [templates.data]);
  const [key, setKey] = useState('');
  const [vars, setVars] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(lead.consentWhatsapp);
  const tpl = approved.find((t) => t.key === key) ?? approved[0];
  useEffect(() => {
    if (!open) return;
    setConsent(lead.consentWhatsapp);
  }, [open, lead.consentWhatsapp]);
  useEffect(() => {
    if (!tpl) return;
    setKey(tpl.key);
    setVars(Object.fromEntries(tpl.variables.map((v) => [v, v === 'name' ? lead.name.split(' ')[0]! : v === 'course' ? (lead.courseName ?? '') : ''])));
  }, [tpl?.key, lead.name, lead.courseName]); // eslint-disable-line react-hooks/exhaustive-deps
  const text = tpl ? fillTemplate(tpl.body, vars) : '';
  const missing = tpl ? tpl.variables.filter((v) => !vars[v]?.trim()) : [];
  const log = useApiMutation(salesContract.logActivity, { invalidate: [['sales']], success: 'WhatsApp logged', onSuccess: () => onOpenChange(false) });
  const blocked = !lead.phone ? 'No phone number on this lead' : !consent ? 'WhatsApp consent not captured yet' : missing.length ? `Fill ${missing.map((m) => `{${m}}`).join(', ')}` : null;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      kicker="WhatsApp · approved templates only"
      title={`Message ${lead.name}`}
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {blocked || !tpl ? (
            <Button variant="primary" disabled>
              Open WhatsApp
            </Button>
          ) : (
            <a
              href={waHref(lead.phone, text)}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: 'primary' })}
              onClick={() => log.mutate({ params: { id: lead.id }, body: { kind: 'whatsapp', summary: `${tpl.name} sent`, templateKey: tpl.key, ...(consent && !lead.consentWhatsapp ? { consentWhatsapp: true } : {}) } })}
            >
              Open WhatsApp
            </a>
          )}
        </>
      }
    >
      <Field label="Template">
        <Select value={tpl?.key ?? ''} onChange={(e) => setKey(e.target.value)} options={approved.map((t) => ({ value: t.key, label: `${t.key} · ${t.name}` }))} placeholder={approved.length ? undefined : 'No approved templates'} />
      </Field>
      {tpl && tpl.variables.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {tpl.variables.map((v) => (
            <Field key={v} label={`{${v}}`}>
              <Input value={vars[v] ?? ''} onChange={(e) => setVars((x) => ({ ...x, [v]: e.target.value }))} placeholder={v === 'batch_dates' ? '3 Nov (Tue/Thu)' : v === 'date' ? 'Sat 18 Oct, 11:00' : ''} />
            </Field>
          ))}
        </div>
      )}
      {tpl && <div className="text-[13px] bg-surface border border-divider p-2.5 whitespace-pre-wrap">{text}</div>}
      {!lead.consentWhatsapp && <Checkbox checked={consent} onChange={setConsent} label="Lead agreed to WhatsApp messages" />}
      {blocked && <Issue kind="needed">{blocked}</Issue>}
    </Dialog>
  );
}

/** Mark lost with a reason (drops the lead out of the kanban). */
export function LostDialog({ lead, open, onOpenChange }: { lead: LeadDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [reason, setReason] = useState<(typeof LOST_REASONS)[number]>('Price');
  const [note, setNote] = useState('');
  const m = useApiMutation(salesContract.setStage, { invalidate: [['sales']], success: `${lead.name} marked lost`, onSuccess: () => onOpenChange(false) });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      kicker={`${lead.stageLabel} → Lost`}
      title={`Mark ${lead.name} lost`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="ink" loading={m.isPending} onClick={() => m.mutate({ params: { id: lead.id }, body: { from: lead.stage, to: 'lost', lostReason: reason, ...(note.trim() ? { note: note.trim() } : {}), undo: false } })}>
            Mark lost
          </Button>
        </>
      }
    >
      <Field label="Reason">
        <Select value={reason} onChange={(e) => setReason(e.target.value as (typeof LOST_REASONS)[number])} options={[...LOST_REASONS]} />
      </Field>
      <Field label="Note (optional)">
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Joined a cheaper weekend course" />
      </Field>
      <div className="text-xs text-neutral-600">Open follow-ups are cancelled. Lost reasons feed the manager’s funnel.</div>
    </Dialog>
  );
}
