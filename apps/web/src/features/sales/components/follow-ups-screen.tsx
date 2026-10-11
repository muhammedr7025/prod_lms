'use client';

import { FOLLOW_UP_CHANNELS, salesContract, type FollowUpItem } from '@exatech/contracts';
import { LEAD_STAGE_LABEL } from '@exatech/domain';
import { Button, buttonVariants, Card, CardBody, CardTitle, Checkbox, cn, Dialog, EmptyState, Field, Input, Kicker, Page, PageHeader, Select, Skeleton, Tag, Textarea } from '@exatech/ui';
import { useEffect, useMemo, useState } from 'react';
import { useApi, useApiMutation } from '@/lib/hooks';
import { defaultFollowUp, fromLocalInput, telHref, waHref } from '../lib';

const CHANNEL_LABEL: Record<string, string> = { call: 'Call', whatsapp: 'WhatsApp', email: 'Email', visit: 'Visit' };

function Row({ f, onOutcome }: { f: FollowUpItem; onOutcome: () => void }) {
  return (
    <div className="px-4 py-3 border-b border-divider grid gap-2 text-[13px]" data-testid="follow-up">
      <div className="flex justify-between gap-2">
        <b className="font-medium">{f.leadName}</b>
        <span className="text-neutral-600 text-xs whitespace-nowrap">
          {f.dueLabel} · {CHANNEL_LABEL[f.channel]}
        </span>
      </div>
      <div className="text-neutral-700">{f.note ?? 'No note'}</div>
      <div className="flex gap-1.5 flex-wrap">
        {f.phone ? (
          <a href={telHref(f.phone)} className={buttonVariants({ variant: 'primary', size: 'sm' })}>
            Call
          </a>
        ) : (
          <Button variant="primary" size="sm" disabled>
            Call
          </Button>
        )}
        {f.phone ? (
          <a href={waHref(f.phone)} target="_blank" rel="noreferrer" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
            WhatsApp
          </a>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onOutcome}>
          Log outcome
        </Button>
      </div>
    </div>
  );
}

function LogOutcomeDialog({ item, onClose }: { item: FollowUpItem | null; onClose: () => void }) {
  const [outcome, setOutcome] = useState('');
  const [withNext, setWithNext] = useState(false);
  const [next, setNext] = useState(defaultFollowUp());
  const [channel, setChannel] = useState<(typeof FOLLOW_UP_CHANNELS)[number]>('call');
  const [note, setNote] = useState('');
  const [advance, setAdvance] = useState(false);
  useEffect(() => {
    if (item) {
      setOutcome('');
      setWithNext(false);
      setNext(defaultFollowUp());
      setChannel(item.channel);
      setNote('');
      setAdvance(false);
    }
  }, [item]);
  const m = useApiMutation(salesContract.completeFollowUp, { invalidate: [['sales']], success: 'Outcome logged', onSuccess: onClose });
  if (!item) return null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      kicker={`${CHANNEL_LABEL[item.channel]} · ${item.dueLabel}`}
      title={`Log outcome · ${item.leadName}`}
      width={500}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={m.isPending}
            disabled={outcome.trim().length < 2 || (withNext && !next)}
            onClick={() =>
              m.mutate({
                params: { id: item.id },
                body: { outcome: outcome.trim(), next: withNext ? { dueAt: fromLocalInput(next), channel, note: note.trim() || null } : null, advance },
              })
            }
          >
            Save outcome
          </Button>
        </>
      }
    >
      <Field label="Outcome">
        <Textarea value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="Spoke for 5 min — wants the weekend batch, will pay after salary credit" autoFocus />
      </Field>
      <Checkbox checked={withNext} onChange={setWithNext} label="Schedule the next follow-up" />
      {withNext && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="When">
            <Input type="datetime-local" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="Channel">
            <Select value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)} options={FOLLOW_UP_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABEL[c]! }))} />
          </Field>
          <Field label="Note" className="col-span-2">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Send EMI options" />
          </Field>
        </div>
      )}
      {item.nextStage && <Checkbox checked={advance} onChange={setAdvance} label={`Advance stage · ${LEAD_STAGE_LABEL[item.stage]} → ${LEAD_STAGE_LABEL[item.nextStage]}`} />}
    </Dialog>
  );
}

function ScheduleDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [search, setSearch] = useState('');
  const [leadId, setLeadId] = useState('');
  const [due, setDue] = useState(defaultFollowUp());
  const [channel, setChannel] = useState<(typeof FOLLOW_UP_CHANNELS)[number]>('call');
  const [note, setNote] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    if (open) {
      setSearch('');
      setLeadId('');
      setDue(defaultFollowUp());
      setChannel('call');
      setNote('');
    }
  }, [open]);
  const leads = useApi(salesContract.leads, { query: { status: 'open', limit: 100, ...(q ? { q } : {}) } }, { enabled: open, placeholderData: (p) => p });
  const options = useMemo(() => (leads.data?.items ?? []).map((l) => ({ value: l.id, label: `${l.name} · ${l.stageLabel}${l.courseName ? ` · ${l.courseName}` : ''}` })), [leads.data]);
  useEffect(() => {
    if (open && !options.some((o) => o.value === leadId)) setLeadId(options[0]?.value ?? '');
  }, [open, options, leadId]);
  const m = useApiMutation(salesContract.scheduleFollowUp, { invalidate: [['sales']], success: 'Follow-up scheduled', onSuccess: () => onOpenChange(false) });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      kicker="Follow-up"
      title="Schedule follow-up"
      width={500}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.isPending} disabled={!leadId || !due} onClick={() => m.mutate({ body: { leadId, dueAt: fromLocalInput(due), channel, note: note.trim() || null } })}>
            Schedule
          </Button>
        </>
      }
    >
      <Field label="Find lead">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or phone" />
      </Field>
      <Field label="Lead">
        <Select value={leadId} onChange={(e) => setLeadId(e.target.value)} options={options} placeholder={options.length ? undefined : 'No open leads match'} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Due">
          <Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
        <Field label="Channel">
          <Select value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)} options={FOLLOW_UP_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABEL[c]! }))} />
        </Field>
      </div>
      <Field label="Note">
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Confirm demo slot" />
      </Field>
    </Dialog>
  );
}

/** Sales · Follow-ups — Overdue and Today queues, templates and personal month stats. */
export function FollowUpsScreen() {
  const data = useApi(salesContract.followUps, {});
  const [outcome, setOutcome] = useState<FollowUpItem | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const d = data.data;
  const queue = (title: string, items: FollowUpItem[] | undefined, ink: boolean) => (
    <Card pad="none" tone={ink ? 'ink' : 'white'} aria-label={title}>
      <div className="flex justify-between items-center px-4 py-3 border-b border-divider">
        <CardTitle>{title}</CardTitle>
        <Tag variant={ink ? 'ink' : 'accent'}>{items?.length ?? '…'}</Tag>
      </div>
      {!items && (
        <div className="p-4 grid gap-3">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      )}
      {items?.map((f) => <Row key={f.id} f={f} onOutcome={() => setOutcome(f)} />)}
      {items && items.length === 0 && <EmptyState title={ink ? 'Nothing overdue' : 'Nothing due today'} body={ink ? 'Every follow-up is on time.' : d?.upcoming ? `${d.upcoming} coming up later.` : 'Schedule one from a lead record.'} />}
    </Card>
  );
  return (
    <Page label="Sales · Follow-ups">
      <PageHeader
        kicker={d ? `${d.dateLabel} · median first response ${d.medianFirstResponse}` : ' '}
        title="Follow-ups"
        actions={
          <Button variant="primary" onClick={() => setScheduleOpen(true)}>
            Schedule follow-up
          </Button>
        }
      />
      {data.error && (
        <Card>
          <EmptyState title="Could not load follow-ups" body={data.error.message} />
        </Card>
      )}
      <div className="grid gap-3.5 items-start" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))' }}>
        {queue('Overdue', d?.overdue, true)}
        {queue('Today', d?.today, false)}
        <Card className="gap-2.5">
          <CardTitle>Templates</CardTitle>
          <CardBody>WhatsApp and email with variables. Approved by Meta for the business account.</CardBody>
          <div className="grid gap-1.5 text-[13px]">
            {!d && <Skeleton className="h-20" />}
            {d?.templates.map((t, i) => (
              <div key={t.id} className={cn('flex justify-between gap-2 py-1.5', i < d.templates.length - 1 && 'border-b border-divider')}>
                <span className="min-w-0 truncate" title={t.body}>
                  {t.key} · {t.variables.length ? t.variables.map((v) => `{${v}}`).join(' ') : t.name.toLowerCase()}
                </span>
                <Tag variant={t.status === 'approved' ? 'accent' : 'neutral'}>{t.status === 'approved' ? 'Approved' : t.status === 'pending' ? 'Pending' : 'Rejected'}</Tag>
              </div>
            ))}
          </div>
          <Kicker className="mt-1">My month</Kicker>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <div className="font-heading font-semibold text-2xl leading-none tabular">{d?.myMonth.calls ?? '—'}</div>
              <div className="text-xs text-neutral-600">Calls</div>
            </div>
            <div>
              <div className="font-heading font-semibold text-2xl leading-none tabular">{d?.myMonth.admissions ?? '—'}</div>
              <div className="text-xs text-neutral-600">Admissions</div>
            </div>
            <div>
              <div className="font-heading font-semibold text-2xl leading-none tabular">{d?.myMonth.pct != null ? `${d.myMonth.pct}%` : '—'}</div>
              <div className="text-xs text-neutral-600">{d?.myMonth.target ? `of target ${d.myMonth.target}` : 'No target set'}</div>
            </div>
          </div>
        </Card>
      </div>
      <LogOutcomeDialog item={outcome} onClose={() => setOutcome(null)} />
      <ScheduleDialog open={scheduleOpen} onOpenChange={setScheduleOpen} />
    </Page>
  );
}
