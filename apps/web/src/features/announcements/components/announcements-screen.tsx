'use client';

import { AUDIENCE_ROLE_LABEL, AUDIENCE_SEGMENT_LABEL, commsContract, type AudienceOptions, type AudienceTarget } from '@exatech/contracts';
import { addDays, todayIST } from '@exatech/domain';
import { Button, Card, CardBody, CardMeta, CardTitle, Checkbox, EmptyState, Field, Icon, Input, Issue, Kicker, Page, PageHeader, Popover, PopoverClose, Select, Skeleton, Tag, Textarea } from '@exatech/ui';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { callApi } from '@/lib/api';
import { useApi, useApiMutation } from '@/lib/hooks';

type Kind = 'batch' | 'role' | 'segment' | 'branch' | 'course';
const ADD_LABEL: Record<Kind, string> = { batch: '+ Batch', role: '+ Role', segment: '+ Segment', branch: '+ Branch', course: '+ Course' };

function optionsFor(kind: Kind, o: AudienceOptions): AudienceTarget[] {
  switch (kind) {
    case 'batch':
      return o.batches.map((b) => ({ type: 'batch', value: b.id, label: `Batch · ${b.label}` }));
    case 'role':
      return o.roles.map((r) => ({ type: 'role', value: r, label: `Role · ${AUDIENCE_ROLE_LABEL[r]}` }));
    case 'segment':
      return o.segments.map((sg) => ({ type: 'segment', value: sg, label: `Segment · ${AUDIENCE_SEGMENT_LABEL[sg]}` }));
    case 'branch':
      return [...(o.institution ? [{ type: 'institution' as const, value: 'institution', label: 'Institution · everyone' }] : []), ...o.branches.map((b) => ({ type: 'branch' as const, value: b.id, label: `Branch · ${b.label}` }))];
    case 'course':
      return o.courses.map((c) => ({ type: 'course', value: c.id, label: `Course · ${c.label}` }));
  }
}

function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Announcements composer (audience chips, schedule, expiry, pin, ack, WhatsApp, AI draft) and the published list with read / ack counts. */
export function AnnouncementsScreen() {
  const { data, isPending, error } = useApi(commsContract.list, {});
  const params = useSearchParams();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<AudienceTarget[]>([]);
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  const [expires, setExpires] = useState(addDays(todayIST(), 14));
  const [pinned, setPinned] = useState(false);
  const [ack, setAck] = useState(false);
  const [whatsapp, setWhatsapp] = useState(true);

  useEffect(() => {
    const seg = params.get('segment');
    if (seg === 'overdue_fees' || seg === 'low_attendance') setAudience([{ type: 'segment', value: seg, label: `Segment · ${AUDIENCE_SEGMENT_LABEL[seg]}` }]);
  }, [params]);

  const debouncedAudience = useDebounced(audience);
  const preview = useQuery({
    queryKey: ['api', 'comms', 'announcements', 'preview', debouncedAudience],
    queryFn: () => callApi(commsContract.preview, { body: { audience: debouncedAudience } }),
    enabled: debouncedAudience.length > 0,
    retry: false,
  });
  const publish = useApiMutation(commsContract.create, {
    invalidate: [['comms']],
    success: (d) => (d.status === 'scheduled' ? `Scheduled · ${d.metaLabel.replace('Scheduled · ', '')}` : `Published to ${d.recipients} people`),
    onSuccess: () => {
      setTitle('');
      setBody('');
      setPinned(false);
      setAck(false);
      setWhen('now');
    },
  });
  const draft = useApiMutation(commsContract.draft, {
    success: 'Draft ready — review before publishing',
    onSuccess: (d) => {
      setTitle(d.title);
      setBody(d.body);
    },
  });
  const withdraw = useApiMutation(commsContract.withdraw, { invalidate: [['comms']], success: 'Withdrawn · it no longer shows in feeds' });

  const opts = data?.options;
  const kinds = useMemo<Kind[]>(() => {
    if (!opts) return [];
    const k: Kind[] = [];
    if (opts.batches.length) k.push('batch');
    if (opts.roles.length) k.push('role');
    if (opts.segments.length) k.push('segment');
    if (opts.branches.length || opts.institution) k.push('branch');
    if (opts.courses.length) k.push('course');
    return k;
  }, [opts]);
  const atIso = when === 'later' && at ? new Date(at).toISOString() : null;
  const issues: string[] = [];
  if (title.trim().length < 3) issues.push('A title');
  if (body.trim().length < 3) issues.push('The message');
  if (audience.length === 0) issues.push('An audience');
  if (when === 'later' && (!at || new Date(at).getTime() < Date.now())) issues.push('A publish time in the future');
  const blocked = issues.length > 0 || (preview.data?.recipients === 0 && !preview.isFetching);

  return (
    <Page label="Branch Admin · Announcements">
      <PageHeader kicker="Communications" title="Announcements" />
      {error && <EmptyState title="Could not load announcements" body={error.message} />}
      <div className="grid gap-3.5 items-start" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))' }}>
        <Card pad="lg" className="gap-3">
          <CardTitle>New announcement</CardTitle>
          <Field label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Timetable change for DM-A next week" maxLength={140} />
          </Field>
          <Field label="Message">
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Rich text · attachments · variables such as the student's name" maxLength={4000} />
          </Field>
          <div className="grid gap-[5px]">
            <span className="text-xs text-ink/70" id="aud-label">
              Audience
            </span>
            <div className="flex gap-1.5 flex-wrap" aria-labelledby="aud-label">
              {audience.map((t) => (
                <button key={`${t.type}:${t.value}`} type="button" className="border-0 p-0 bg-transparent cursor-pointer" onClick={() => setAudience(audience.filter((x) => x !== t))} aria-label={`Remove ${t.label}`}>
                  <Tag variant="accent" className="gap-1.5">
                    {t.label} <Icon name="x" size={10} />
                  </Tag>
                </button>
              ))}
              {kinds.map((k) => (
                <Popover
                  key={k}
                  width={240}
                  align="start"
                  trigger={
                    <button type="button" className="border-0 p-0 bg-transparent cursor-pointer">
                      <Tag variant="outline">{k === 'segment' && opts?.segments.length === 1 ? `+ Segment: ${AUDIENCE_SEGMENT_LABEL[opts.segments[0]!]}` : ADD_LABEL[k]}</Tag>
                    </button>
                  }
                >
                  <div className="p-1.5 grid max-h-[260px] overflow-auto" role="listbox" aria-label={ADD_LABEL[k]}>
                    {opts &&
                      optionsFor(k, opts)
                        .filter((o) => !audience.some((a) => a.type === o.type && a.value === o.value))
                        .map((o) => (
                          <PopoverClose asChild key={`${o.type}:${o.value}`}>
                            <button type="button" role="option" aria-selected={false} className="text-left px-2.5 py-1.5 text-[13px] border-0 bg-transparent cursor-pointer hover:bg-accent-100" onClick={() => setAudience([...audience, o])}>
                              {o.label.split(' · ').slice(1).join(' · ') || o.label}
                            </button>
                          </PopoverClose>
                        ))}
                  </div>
                </Popover>
              ))}
            </div>
            <div className="text-xs text-neutral-600" aria-live="polite">
              {audience.length === 0
                ? 'Batches, branches and courses pick who; a segment narrows it; roles choose students, parents, teachers or staff (students + parents by default).'
                : preview.isFetching || audience !== debouncedAudience
                  ? 'Counting recipients…'
                  : preview.error
                    ? preview.error.message
                    : preview.data
                      ? `${preview.data.recipients.toLocaleString('en-IN')} recipients · ${preview.data.students} students · ${preview.data.parents} parents${preview.data.staff ? ` · ${preview.data.staff} staff` : ''}`
                      : ''}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Publish">
              <Select
                value={when}
                onChange={(e) => setWhen(e.target.value as 'now' | 'later')}
                options={[
                  { value: 'now', label: 'Now' },
                  { value: 'later', label: 'Schedule…' },
                ]}
              />
            </Field>
            <Field label="Expires">
              <Input type="date" value={expires} min={todayIST()} onChange={(e) => setExpires(e.target.value)} />
            </Field>
            {when === 'later' && (
              <Field label="Publish at" className="col-span-2">
                <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
              </Field>
            )}
          </div>
          <div className="flex gap-4 flex-wrap text-[13px]">
            <Checkbox checked={pinned} onChange={setPinned} label="Pin" />
            <Checkbox checked={ack} onChange={setAck} label="Acknowledgement required" />
            <Checkbox checked={whatsapp} onChange={setWhatsapp} label="Also WhatsApp" />
          </div>
          {issues.length > 0 && (title || body || audience.length > 0) && (
            <div className="grid gap-1">
              {issues.map((i) => (
                <Issue key={i} kind="needed">
                  {i}
                </Issue>
              ))}
            </div>
          )}
          {preview.data?.recipients === 0 && !preview.isFetching && audience.length > 0 && <Issue kind="blocked">Nobody matches this audience</Issue>}
          <div className="flex gap-2 justify-end items-center flex-wrap">
            <span title={data?.aiEnabled ? 'Drafts a title and message from your notes — never sends anything' : 'AI assist is not configured on this server (ANTHROPIC_API_KEY)'}>
              <Button variant="secondary" disabled={!data?.aiEnabled || (!title.trim() && !body.trim())} loading={draft.isPending} onClick={() => draft.mutate({ body: { title: title.trim(), notes: body.trim(), audience: audience.map((a) => a.label).join(', ') } })}>
                Draft with AI (opt-in)
              </Button>
            </span>
            <Button
              variant="primary"
              disabled={blocked}
              loading={publish.isPending}
              onClick={() => publish.mutate({ body: { title: title.trim(), body: body.trim(), audience, publishAt: atIso, expiresOn: expires || null, pinned, ackRequired: ack, alsoWhatsapp: whatsapp } })}
            >
              {when === 'later' ? 'Schedule' : 'Publish'}
            </Button>
          </div>
          {opts && (
            <div className="text-[11px] text-neutral-600">
              {opts.limitNote}
              {!data?.aiEnabled && ' · AI drafting is off (no ANTHROPIC_API_KEY on the server)'}
            </div>
          )}
        </Card>

        <div className="grid gap-2.5 content-start">
          {isPending && Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-28" />)}
          {data?.items.length === 0 && <EmptyState title="No announcements yet" body="Published items appear instantly on student and parent home screens." />}
          {data?.items.map((an) => (
            <Card key={an.id} pad="md" className="gap-1.5" data-testid="announcement-card">
              <div className="flex justify-between gap-2">
                <Kicker>{an.kicker}</Kicker>
                <Tag variant={an.metaTag}>{an.metaLabel}</Tag>
              </div>
              <CardTitle>{an.title}</CardTitle>
              <CardBody className="whitespace-pre-line">{an.body}</CardBody>
              <div className="flex justify-between items-center gap-2">
                <CardMeta>
                  {an.authorName}
                  {an.ackRequired ? ' · acknowledgement required' : ''}
                  {an.alsoWhatsapp ? ' · WhatsApp' : ''}
                </CardMeta>
                {an.canWithdraw && (
                  <Button variant="ghost" size="sm" loading={withdraw.isPending && withdraw.variables?.params.id === an.id} onClick={() => withdraw.mutate({ params: { id: an.id } })}>
                    Withdraw
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      </div>
    </Page>
  );
}
