'use client';

import { parentRequestsContract, type ParentMessageItem, type PtmItem } from '@exatech/contracts';
import { formatRelative } from '@exatech/domain';
import { Button, Card, CardMeta, CardTitle, Input, Kicker, Tag, Textarea } from '@exatech/ui';
import { useState } from 'react';
import { useApi, useApiMutation } from '@/lib/hooks';

/**
 * Parent messages (moderated) and PTM requests. Branch Admins moderate and
 * can decide PTMs; teachers answer delivered messages and decide PTMs for
 * students in their batches. Hidden when nothing is waiting. `compact` = phone layout (teacher app).
 */
export function ParentRequestsCard({ compact = false }: { compact?: boolean }) {
  const { data } = useApi(parentRequestsContract.inbox, {}, { staleTime: 15_000 });
  if (!data) return null;
  const total = data.messages.length + data.ptm.length;
  if (total === 0) return null;
  return (
    <Card tone="white" pad={compact ? 'md' : 'lg'} data-testid="parent-requests">
      <div className="flex justify-between items-center gap-2">
        {compact ? <Kicker>From parents</Kicker> : <CardTitle>Parent messages &amp; PTM</CardTitle>}
        <Tag variant="ink">{total} waiting</Tag>
      </div>
      <div className="grid">
        {data.messages.map((m) => (
          <MessageRow key={m.id} m={m} role={data.role} compact={compact} />
        ))}
        {data.ptm.map((p) => (
          <PtmRow key={p.id} p={p} compact={compact} />
        ))}
      </div>
    </Card>
  );
}

function MessageRow({ m, role, compact }: { m: ParentMessageItem; role: 'moderator' | 'teacher'; compact: boolean }) {
  const [note, setNote] = useState('');
  const [reply, setReply] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const inv = [['comms', 'parent-requests']] as const;
  const moderate = useApiMutation(parentRequestsContract.moderate, { invalidate: inv, success: (r) => (r.status === 'delivered' ? `Delivered to ${r.teacherName ?? 'the class teacher'}` : 'Message rejected · parent informed') });
  const answer = useApiMutation(parentRequestsContract.reply, { invalidate: inv, success: 'Reply sent to the parent' });
  const btn = compact ? 'min-h-11' : undefined;
  return (
    <div className="py-2.5 border-t border-divider grid gap-1.5 text-[13px]" data-testid="parent-message">
      <div className="flex justify-between gap-2">
        <span>
          <b className="font-medium">{m.parentName}</b> · parent of {m.studentName} · {m.batchCode}
          {role === 'moderator' && m.teacherName && <span className="text-neutral-600"> → {m.teacherName}</span>}
        </span>
        <span className="text-[11px] text-neutral-500 whitespace-nowrap">{formatRelative(new Date(m.createdAt))}</span>
      </div>
      <div className="bg-surface border border-divider px-2.5 py-2 whitespace-pre-wrap">{m.body}</div>
      {role === 'moderator' ? (
        rejecting ? (
          <div className="flex gap-1.5 flex-wrap">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why it can't be delivered (sent to the parent)" className="flex-1 min-w-[200px]" aria-label="Reason" />
            <Button variant="secondary" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
            <Button variant="ink" disabled={!note.trim()} loading={moderate.isPending} onClick={() => moderate.mutate({ params: { id: m.id }, body: { decision: 'reject', note: note.trim() } })}>
              Reject
            </Button>
          </div>
        ) : (
          <div className="flex gap-1.5 justify-end">
            <Button variant="secondary" size="sm" onClick={() => setRejecting(true)}>
              Reject
            </Button>
            <Button variant="primary" size="sm" loading={moderate.isPending} onClick={() => moderate.mutate({ params: { id: m.id }, body: { decision: 'approve' } })}>
              Approve &amp; deliver
            </Button>
          </div>
        )
      ) : (
        <div className="grid gap-1.5">
          <Textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply to the parent (sent in-app and on WhatsApp)" className="min-h-[70px]" aria-label="Reply" />
          <Button variant="primary" className={btn} disabled={reply.trim().length < 2} loading={answer.isPending} onClick={() => answer.mutate({ params: { id: m.id }, body: { reply: reply.trim() } })}>
            Send reply
          </Button>
        </div>
      )}
    </div>
  );
}

function PtmRow({ p, compact }: { p: PtmItem; compact: boolean }) {
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');
  const decide = useApiMutation(parentRequestsContract.decidePtm, {
    invalidate: [['comms', 'parent-requests']],
    success: (r) => (r.status === 'confirmed' ? 'PTM confirmed · parent informed' : 'PTM declined · parent informed'),
  });
  const btn = compact ? 'min-h-11 flex-1' : undefined;
  return (
    <div className="py-2.5 border-t border-divider grid gap-1.5 text-[13px]" data-testid="ptm-request">
      <div className="flex justify-between gap-2">
        <span>
          <Tag variant="outline" size="sm" className="mr-1.5">
            PTM
          </Tag>
          <b className="font-medium">{p.parentName}</b> · {p.studentName} · {p.batchCode}
        </span>
        <span className="text-[11px] text-neutral-500 whitespace-nowrap">{formatRelative(new Date(p.createdAt))}</span>
      </div>
      <CardMeta className="text-[12px] text-neutral-700">
        {p.slotLabel}
        {p.note ? ` · “${p.note}”` : ''}
      </CardMeta>
      {declining ? (
        <div className="flex gap-1.5 flex-wrap">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Suggest another time or say why" className="flex-1 min-w-[200px]" aria-label="Note to the parent" />
          <Button variant="secondary" className={btn} onClick={() => setDeclining(false)}>
            Cancel
          </Button>
          <Button variant="ink" className={btn} disabled={!note.trim()} loading={decide.isPending} onClick={() => decide.mutate({ params: { id: p.id }, body: { decision: 'declined', note: note.trim() } })}>
            Decline
          </Button>
        </div>
      ) : (
        <div className="flex gap-1.5 justify-end">
          <Button variant="secondary" size={compact ? 'lg' : 'sm'} className={btn} onClick={() => setDeclining(true)}>
            Decline
          </Button>
          <Button variant="primary" size={compact ? 'lg' : 'sm'} className={btn} loading={decide.isPending} onClick={() => decide.mutate({ params: { id: p.id }, body: { decision: 'confirmed' } })}>
            Confirm slot
          </Button>
        </div>
      )}
    </div>
  );
}
