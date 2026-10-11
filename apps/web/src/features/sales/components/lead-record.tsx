'use client';

import { salesContract } from '@exatech/contracts';
import { Button, buttonVariants, Card, CardTitle, cn, EmptyState, Input, Issue, Kicker, Skeleton, Tag } from '@exatech/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useCan } from '@/components/me-context';
import { useApi, useApiMutation } from '@/lib/hooks';
import { activityWhen, defaultFollowUp, fromLocalInput, stageTag, telHref, toLocalInput } from '../lib';
import { LogCallDialog, LostDialog, WhatsAppDialog } from './lead-dialogs';

/** Right-hand "Lead record" panel: contact actions, timeline, next follow-up, lost, convert. */
export function LeadRecord({ id }: { id: string | null }) {
  const lead = useApi(salesContract.getLead, { params: { id: id ?? '' } }, { enabled: !!id });
  const canUpdate = useCan('sales:leads.update');
  const canAdmit = useCan('admissions:create');
  const [dlg, setDlg] = useState<'call' | 'wa' | 'lost' | null>(null);
  const [next, setNext] = useState('');
  const logEmail = useApiMutation(salesContract.logActivity, { invalidate: [['sales']], success: 'Email logged' });
  const schedule = useApiMutation(salesContract.scheduleFollowUp, { invalidate: [['sales']], success: 'Follow-up saved' });

  const l = lead.data;
  useEffect(() => {
    setNext(l?.nextFollowUpAt ? toLocalInput(new Date(l.nextFollowUpAt)) : defaultFollowUp());
  }, [l?.id, l?.nextFollowUpAt]);

  if (!id)
    return (
      <Card>
        <Kicker>Lead record</Kicker>
        <EmptyState title="Pick a lead" body="Select a row to see its consent flags, activity timeline and next follow-up." />
      </Card>
    );
  if (lead.error)
    return (
      <Card>
        <Kicker>Lead record</Kicker>
        <EmptyState title="Could not open this lead" body={lead.error.message} />
      </Card>
    );
  if (!l)
    return (
      <Card className="gap-2.5" aria-busy>
        <Kicker>Lead record</Kicker>
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-24 w-full" />
      </Card>
    );

  const open = l.stage !== 'won' && l.stage !== 'lost';
  return (
    <Card className="gap-2.5" aria-label="Lead record">
      <Kicker>Lead record</Kicker>
      <CardTitle>{l.name}</CardTitle>
      <div className="text-[13px] text-neutral-700">
        {l.courseName ?? 'Course not set'} · {l.phoneDisplay} · {l.source}
        {l.email ? ` · ${l.email}` : ''}
      </div>
      <div className="flex gap-1.5 flex-wrap">
        <Tag variant={stageTag(l.stage)}>{l.stage === 'lost' && l.lostReason ? `Lost · ${l.lostReason}` : l.stageLabel}</Tag>
        <Tag variant="neutral">Score {l.score}</Tag>
        <Tag variant={l.consentWhatsapp ? 'neutral' : 'plain'}>Consent · WhatsApp {l.consentWhatsapp ? '✓' : '—'}</Tag>
        {l.email && <Tag variant={l.consentEmail ? 'neutral' : 'plain'}>Email {l.consentEmail ? '✓' : '—'}</Tag>}
        <Tag variant="plain">Owner · {l.ownerName}</Tag>
      </div>
      {canUpdate && (
        <div className="flex gap-1.5">
          {l.phone ? (
            <a href={telHref(l.phone)} className={cn(buttonVariants({ variant: 'primary' }), 'flex-1')} onClick={() => setDlg('call')}>
              Call
            </a>
          ) : (
            <Button variant="primary" className="flex-1" disabled>
              Call
            </Button>
          )}
          <Button variant="secondary" className="flex-1" onClick={() => setDlg('wa')} disabled={!l.phone}>
            WhatsApp
          </Button>
          {l.email ? (
            <a
              href={`mailto:${l.email}?subject=${encodeURIComponent(`${l.courseName ?? 'Your course enquiry'} · Exatech`)}`}
              className={cn(buttonVariants({ variant: 'secondary' }), 'flex-1')}
              onClick={() => logEmail.mutate({ params: { id: l.id }, body: { kind: 'email', summary: `Email sent to ${l.email}` } })}
            >
              Email
            </a>
          ) : (
            <Button variant="secondary" className="flex-1" disabled title="No email on this lead">
              Email
            </Button>
          )}
        </div>
      )}
      {!l.firstResponseAt && open && <div className="text-xs text-ink font-medium">First-response timer running since {activityWhen(String(l.createdAt))}</div>}

      <Kicker className="mt-1.5">Activity timeline</Kicker>
      <ol className="grid gap-2 text-xs border-l border-divider pl-3 m-0 list-none max-h-[280px] overflow-auto" aria-label="Activity timeline">
        {l.activities.map((a) => (
          <li key={a.id}>
            <b className="font-medium">{a.summary}</b>
            <div className="text-neutral-600">
              {activityWhen(String(a.at))}
              {a.actorName ? ` · ${a.actorName.split(' ')[0]}` : ''}
            </div>
          </li>
        ))}
      </ol>

      {open && canUpdate && (
        <>
          <Kicker className="mt-1.5">Next follow-up</Kicker>
          <div className="flex gap-1.5">
            <Input type="datetime-local" value={next} onChange={(e) => setNext(e.target.value)} aria-label="Next follow-up" />
            <Button
              variant="secondary"
              loading={schedule.isPending}
              disabled={!next}
              onClick={() => schedule.mutate({ body: { leadId: l.id, dueAt: fromLocalInput(next), channel: 'call', note: null } })}
            >
              Save
            </Button>
          </div>
          {l.nextFollowUpNote && l.nextFollowUpAt && <div className="text-xs text-neutral-600">Scheduled: {activityWhen(String(l.nextFollowUpAt))} · {l.nextFollowUpNote}</div>}
        </>
      )}

      {canUpdate && open && l.stage !== 'admission_in_progress' && (
        <Button variant="ghost" className="justify-start" onClick={() => setDlg('lost')}>
          Mark lost
        </Button>
      )}
      {canAdmit &&
        (l.canConvert ? (
          <Link href={`/sales/admission?lead=${l.id}`} className={cn(buttonVariants({ variant: 'primary' }), 'mt-1')}>
            <span className="corner tl" aria-hidden />
            <span className="corner tr" aria-hidden />
            <span className="corner bl" aria-hidden />
            <span className="corner br" aria-hidden />
            {l.admissionStatus === 'draft' || l.admissionStatus === 'returned' ? 'Continue admission' : 'Convert to admission'}
          </Link>
        ) : (
          <Issue kind="ok">{l.stage === 'won' ? 'Won · enrolled' : l.stage === 'lost' ? 'Lost — reopen from the pipeline to convert' : `Application ${l.admissionStatus?.replace('_', ' ') ?? 'in progress'}`}</Issue>
        ))}

      <LogCallDialog lead={l} open={dlg === 'call'} onOpenChange={(o) => setDlg(o ? 'call' : null)} />
      <WhatsAppDialog lead={l} open={dlg === 'wa'} onOpenChange={(o) => setDlg(o ? 'wa' : null)} />
      <LostDialog lead={l} open={dlg === 'lost'} onOpenChange={(o) => setDlg(o ? 'lost' : null)} />
    </Card>
  );
}
