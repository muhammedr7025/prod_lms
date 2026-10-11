'use client';

import { academicsStudentsContract, AUTH_PATHS, DOCUMENT_PATHS } from '@exatech/contracts';
import { formatINR } from '@exatech/domain';
import { Button, Card, CardTitle, Dialog, EmptyState, Field, Input, Kicker, Table, TableScroll, Tag, TD, TH, cn, toast } from '@exatech/ui';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { DrawerLayout, DrawerLoading } from '@/components/drawers/drawer-host';
import { useDrawer } from '@/components/drawers/drawer-context';
import { useCan } from '@/components/me-context';
import { authPost, type ApiError } from '@/lib/api';
import { useApi, useApiMutation } from '@/lib/hooks';
import { TransferDialog } from './components/transfer-dialog';

function Kpi({ label, value, meta, ink }: { label: string; value: ReactNode; meta?: ReactNode; ink?: boolean }) {
  return (
    <Card pad="sm" className="gap-0.5 px-3 py-2.5">
      <Kicker className={ink ? 'text-ink' : undefined}>{label}</Kicker>
      <div className="font-heading font-semibold text-[26px] leading-none tabular">{value}</div>
      {meta != null && <div className="text-[11px] text-ink/50">{meta}</div>}
    </Card>
  );
}

/** Student panel: KPIs, actions (collect, timetable, transfer, ID card, view as student), profile, fee account, attendance, marks, documents, timeline. */
export default function StudentDrawer({ id }: { id: string }) {
  const { data, isPending, error } = useApi(academicsStudentsContract.get, { params: { id } });
  const router = useRouter();
  const drawer = useDrawer();
  const canCollect = useCan('finance:payment.collect');
  const canManage = useCan('academics:students.manage');
  const canImpersonate = useCan('institution:impersonate');
  const [transferOpen, setTransferOpen] = useState(false);
  const [viewAs, setViewAs] = useState(false);
  const [reason, setReason] = useState('');
  const [starting, setStarting] = useState(false);
  const reissue = useApiMutation(academicsStudentsContract.reissueCard, { invalidate: [['academics', 'students']], success: 'New card issued · the old QR no longer works' });

  if (isPending) return <DrawerLoading />;
  if (error || !data)
    return (
      <DrawerLayout kicker="Student" title="Student">
        <EmptyState title="Could not load this student" body={error?.message} />
      </DrawerLayout>
    );

  const go = (href: string) => {
    drawer.close();
    router.push(href);
  };
  const startViewAs = async () => {
    if (!data.userId) return;
    setStarting(true);
    try {
      await authPost(AUTH_PATHS.impersonate, { userId: data.userId, reason: reason.trim() });
      window.location.assign('/');
    } catch (err) {
      toast.error((err as ApiError).message);
      setStarting(false);
    }
  };
  const k = data.kpis;
  return (
    <DrawerLayout kicker={`Student · ${data.branchName}`} title={data.name} sub={data.sub} tag={data.tag} tagVariant={data.tagVariant === 'ink' ? 'ink' : 'accent'}>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <Kpi label="Attendance" value={`${k.attendancePct}%`} meta={k.attendanceNote} ink={k.attendancePct < 75} />
        <Kpi label="Fee balance" value={formatINR(k.feeBalance)} meta={k.feeNext} />
        <Kpi label="Published marks" value={k.publishedMarks} meta="exams" />
        <Kpi label="Pending work" value={k.pendingWork} meta={k.pendingNote} />
      </div>
      <div className="flex gap-2 flex-wrap">
        {canCollect && (
          <Button variant="primary" onClick={() => go(`/finance/desk?student=${data.id}`)}>
            Collect payment
          </Button>
        )}
        <Button variant="secondary" disabled={!data.batchId} onClick={() => go(`/timetable?batch=${data.batchId}`)}>
          Timetable
        </Button>
        {canManage && (
          <Button variant="secondary" disabled={data.enrollmentStatus !== 'active'} onClick={() => setTransferOpen(true)}>
            Transfer batch
          </Button>
        )}
        <a href={DOCUMENT_PATHS.idCard(data.id)} target="_blank" rel="noopener">
          <Button variant="secondary">Print ID card</Button>
        </a>
        {canManage && (
          <Button variant="ghost" loading={reissue.isPending} onClick={() => reissue.mutate({ params: { id: data.id } })}>
            Reissue card
          </Button>
        )}
        {canImpersonate && data.userId && (
          <Button variant="ghost" onClick={() => setViewAs(true)}>
            View as student
          </Button>
        )}
      </div>

      <Card pad="md" className="gap-0">
        <CardTitle className="mb-1.5">Profile</CardTitle>
        {data.facts.map(([label, value], i) => (
          <div key={label} className={cn('grid grid-cols-[140px_1fr] gap-2.5 py-1.5 text-[13px]', i < data.facts.length - 1 && 'border-b border-divider')}>
            <span className="text-neutral-600">{label}</span>
            <span className="min-w-0 break-words">{value}</span>
          </div>
        ))}
      </Card>

      <Card pad="none">
        <div className="flex justify-between items-center px-3.5 py-2.5 border-b border-divider">
          <CardTitle>Fee account</CardTitle>
          <Tag variant={data.fee.tag}>{data.fee.label}</Tag>
        </div>
        <TableScroll>
          <Table className="text-[13px]">
            <thead>
              <tr>
                <TH className="first:pl-3.5">Instalment</TH>
                <TH>Due</TH>
                <TH>Amount</TH>
                <TH>Paid</TH>
                <TH>Balance</TH>
                <TH>Status</TH>
              </tr>
            </thead>
            <tbody>
              {data.fee.rows.map((r) => (
                <tr key={r.id} className={cn(r.highlight && 'bg-accent-100')}>
                  <TD className="first:pl-3.5">{r.name}</TD>
                  <TD>{r.dueLabel}</TD>
                  <TD className="tabular">{formatINR(r.amount)}</TD>
                  <TD className="tabular">{formatINR(r.paid)}</TD>
                  <TD className="tabular">{formatINR(r.balance)}</TD>
                  <TD>
                    <Tag variant={r.tag}>{r.status}</Tag>
                  </TD>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableScroll>
        {data.fee.rows.length === 0 && <EmptyState className="py-4" title="No fee schedule" body="Fee accounts are created on admission approval (or by Finance after a go-live import)." />}
      </Card>

      <div className="grid sm:grid-cols-2 gap-3">
        <Card pad="md" className="gap-0">
          <CardTitle className="mb-1.5">Attendance · recent</CardTitle>
          {data.attendance.length === 0 && <div className="text-[13px] text-neutral-600">No sessions marked yet</div>}
          {data.attendance.map((a, i) => (
            <div key={`${a.date}-${i}`} className={cn('flex justify-between gap-2 py-1.5 text-[13px]', i < data.attendance.length - 1 && 'border-b border-divider')}>
              <span>
                {a.label}
                <div className="text-[11px] text-neutral-600">{a.topic}</div>
              </span>
              <Tag variant={a.tag}>{a.statusLabel}</Tag>
            </div>
          ))}
        </Card>
        <Card pad="md" className="gap-0">
          <CardTitle className="mb-1.5">Marks · published</CardTitle>
          {data.marks.length === 0 && <div className="text-[13px] text-neutral-600">Nothing published yet — drafts are never shown</div>}
          {data.marks.map((m, i) => (
            <div key={m.examId} className={cn('flex justify-between gap-2 py-1.5 text-[13px]', i < data.marks.length - 1 && 'border-b border-divider')}>
              <span>
                {m.name}
                <div className="text-[11px] text-neutral-600">
                  {m.when} · avg {m.average}
                </div>
              </span>
              <b className="font-semibold tabular whitespace-nowrap">
                {m.score} / {m.max}
              </b>
            </div>
          ))}
          <Kicker className="mt-3">Documents</Kicker>
          <div className="flex gap-1.5 flex-wrap mt-1.5">
            {data.documents.length === 0 && <span className="text-[13px] text-neutral-600">None on file</span>}
            {data.documents.map((d) => (
              <Tag key={d} variant="outline">
                {d}
              </Tag>
            ))}
          </div>
        </Card>
      </div>

      <Card pad="md" className="gap-0">
        <CardTitle className="mb-1.5">Timeline</CardTitle>
        {data.timeline.map((t, i) => (
          <div key={`${t.at}-${i}`} className={cn('grid grid-cols-[90px_1fr] gap-2.5 py-1.5 text-[13px]', i < data.timeline.length - 1 && 'border-b border-divider')}>
            <span className="text-neutral-600">{t.when}</span>
            <span>{t.text}</span>
          </div>
        ))}
      </Card>

      {canManage && <TransferDialog student={data} open={transferOpen} onClose={() => setTransferOpen(false)} />}
      <Dialog
        open={viewAs}
        onOpenChange={setViewAs}
        kicker="Read-only · 15 minutes · logged"
        title={`View as ${data.name}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setViewAs(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={reason.trim().length < 3} loading={starting} onClick={startViewAs}>
              Start viewing
            </Button>
          </>
        }
      >
        <Field label="Reason (logged in the audit trail)">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Support · student cannot see notes" autoFocus />
        </Field>
      </Dialog>
    </DrawerLayout>
  );
}
