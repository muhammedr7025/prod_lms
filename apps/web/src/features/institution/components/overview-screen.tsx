'use client';

import { approvalsContract, auditContract, institutionContract, type Approval } from '@exatech/contracts';
import { formatINRCompact, toISTTime } from '@exatech/domain';
import { Bar, Button, Card, CardHead, CardTitle, Dialog, EmptyState, Field, Grid, Page, PageHeader, Skeleton, Stat, Table, TableScroll, Tag, Textarea, TD, TH, TR } from '@exatech/ui';
import Link from 'next/link';
import { useState } from 'react';
import { useDrawer } from '@/components/drawers/drawer-context';
import { useBranch, useCan } from '@/components/me-context';
import { useApi, useApiMutation } from '@/lib/hooks';
import { useSecondsSince } from './parts';

/** Super Admin · Overview: institution KPIs for the selected branch scope, by-branch table, approvals above thresholds and the last hour of audit. */
export function OverviewScreen() {
  const { label } = useBranch();
  const drawer = useDrawer();
  const overview = useApi(institutionContract.overview, {}, { refetchInterval: 60_000 });
  const canDecide = useCan('institution:approvals.decide');
  const canAudit = useCan('audit:read');
  const approvals = useApi(approvalsContract.list, { query: { status: 'pending', level: 'super_admin' } }, { enabled: canDecide });
  const audit = useApi(auditContract.recent, {}, { enabled: canAudit });
  const ago = useSecondsSince(overview.data?.computedAt);
  const [returning, setReturning] = useState<Approval | null>(null);
  const [note, setNote] = useState('');
  const decide = useApiMutation(approvalsContract.decide, {
    invalidate: [['approvals'], ['institution'], ['audit'], ['admissions']],
    success: (a) => (a.status === 'approved' ? `Approved · ${a.title}` : `Returned to ${a.requestedByName} · ${a.title}`),
    onSuccess: () => {
      setReturning(null);
      setNote('');
    },
  });
  const k = overview.data?.kpis;
  const items = approvals.data ?? [];

  return (
    <Page label="Super Admin · Overview">
      <PageHeader
        kicker={`Institution · ${label}`}
        title="Overview"
        actions={
          <>
            <a href={institutionContract.exportPath} download>
              <Button variant="secondary">Export report</Button>
            </a>
            <Link href="/announcements">
              <Button variant="primary">New announcement</Button>
            </Link>
          </>
        }
      />

      {overview.error && <EmptyState title="Could not load the overview" body={overview.error.message} />}
      <Grid min={170} gap={14} className="items-stretch" data-testid="overview-kpis">
        {!k &&
          !overview.error &&
          Array.from({ length: 5 }, (_, i) => (
            <Card key={i} pad="md" className="gap-1.5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-8 w-28" />
              <Skeleton className="h-3 w-32" />
            </Card>
          ))}
        {k && (
          <>
            <Stat label={`Revenue · ${k.monthLabel}`} value={formatINRCompact(k.revenue)} meta={k.revenueNote} />
            <Stat label="Collected" value={formatINRCompact(k.collected)} meta={`${k.collectedPct}% of target`}>
              <Bar value={k.collectedPct} className="mt-1.5" />
            </Stat>
            <Stat label="Dues outstanding" value={formatINRCompact(k.dues)} meta={k.duesNote} />
            <Stat label={`Admissions · ${k.monthLabel}`} value={k.admissions.toLocaleString('en-IN')} meta={`${k.admissionsNote} · ${k.awaitingApproval} awaiting approval`} />
            <Stat label="Active students" value={k.activeStudents.toLocaleString('en-IN')} meta={k.studentsNote} />
          </>
        )}
      </Grid>

      <Card pad="none">
        <CardHead>
          <CardTitle>By branch</CardTitle>
          <Tag variant="neutral">{overview.data && ago !== null ? `Materialised · refreshed ${ago < 5 ? 'just now' : `${ago} s ago`}` : 'Materialised · refreshed ≤ 60 s'}</Tag>
        </CardHead>
        <TableScroll minWidth={760}>
          <Table>
            <thead>
              <tr>
                <TH>Branch</TH>
                <TH>Students</TH>
                <TH>Admissions</TH>
                <TH>Collection</TH>
                <TH>Dues</TH>
                <TH>Collection vs target</TH>
                <TH>Status</TH>
              </tr>
            </thead>
            <tbody>
              {overview.isPending &&
                Array.from({ length: 3 }, (_, i) => (
                  <tr key={i}>
                    <TD colSpan={7}>
                      <Skeleton className="h-5" />
                    </TD>
                  </tr>
                ))}
              {overview.data?.branches.map((b) => (
                <TR key={b.id} onClick={() => drawer.open('branch', b.id)} data-testid="branch-row">
                  <TD className="font-medium text-accent-800 underline underline-offset-[3px]">{b.name}</TD>
                  <TD className="tabular">{b.students.toLocaleString('en-IN')}</TD>
                  <TD className="tabular">{b.admissions}</TD>
                  <TD className="tabular">{formatINRCompact(b.collected)}</TD>
                  <TD className="tabular">{formatINRCompact(b.dues)}</TD>
                  <TD>
                    <div className="flex items-center gap-2">
                      <Bar value={b.collectedPct} height={5} className="flex-1 max-w-[120px]" />
                      <span className="tabular">{b.collectedPct}%</span>
                    </div>
                  </TD>
                  <TD>
                    <Tag variant={b.statusTag}>{b.statusLabel}</Tag>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableScroll>
        {overview.data && overview.data.branches.length === 0 && <EmptyState title="No branches in this scope" body="Add a branch from Branches, or switch to All branches." />}
      </Card>

      <Grid min={300} gap={14}>
        {canDecide && (
          <Card pad="lg" className="gap-2.5" data-testid="approvals-card">
            <div className="flex justify-between items-center">
              <CardTitle>Awaiting your approval</CardTitle>
              <Tag variant="ink">{items.length}</Tag>
            </div>
            <div className="grid text-[13px]">
              {approvals.isPending && <Skeleton className="h-16" />}
              {approvals.error && <div className="py-3.5 text-neutral-600">{approvals.error.message}</div>}
              {items.map((a) => (
                <div key={a.id} data-testid="approval-row" className="flex justify-between gap-2.5 py-2 border-b border-divider flex-wrap">
                  <div className="min-w-[220px] flex-1">
                    <div className="font-medium">{a.title}</div>
                    <div className="text-neutral-600">{a.summary}</div>
                    <div className="text-[11px] text-neutral-500">
                      {a.branchName ?? 'Institution'} · requested by {a.requestedByName}
                    </div>
                  </div>
                  <div className="flex gap-1.5 items-start">
                    <Button variant="secondary" size="sm" onClick={() => setReturning(a)} disabled={decide.isPending}>
                      Return
                    </Button>
                    <Button variant="primary" size="sm" loading={decide.isPending && decide.variables?.params.id === a.id && decide.variables.body.decision === 'approved'} onClick={() => decide.mutate({ params: { id: a.id }, body: { decision: 'approved' } })}>
                      Approve
                    </Button>
                  </div>
                </div>
              ))}
              {approvals.data && items.length === 0 && <div className="py-3.5 text-neutral-600">Nothing waiting · every decision is in the audit log.</div>}
            </div>
          </Card>
        )}
        {canAudit && (
          <Card pad="lg" className="gap-2.5">
            <div className="flex justify-between items-center">
              <CardTitle>Audit · last hour</CardTitle>
              <Link href="/audit" className="text-xs text-accent-800 underline underline-offset-[3px]">
                Open log
              </Link>
            </div>
            <div className="grid">
              {audit.isPending && <Skeleton className="h-24" />}
              {audit.data?.length === 0 && <div className="py-3.5 text-[13px] text-neutral-600">No activity recorded yet today.</div>}
              {audit.data?.map((a) => (
                <div key={a.id} className="grid grid-cols-[52px_1fr_auto] gap-2.5 text-[13px] py-1.5 border-b border-divider items-start">
                  <span className="text-neutral-500 tabular">{toISTTime(new Date(a.at))}</span>
                  <span className="min-w-0">
                    <b className="font-medium">{a.actorName}</b> · {a.action}
                  </span>
                  {a.roleLabel ? <Tag variant="neutral">{a.roleLabel}</Tag> : <span />}
                </div>
              ))}
            </div>
          </Card>
        )}
      </Grid>

      <Dialog
        open={!!returning}
        onOpenChange={(o) => !o && setReturning(null)}
        kicker="Return to requester"
        title={returning?.title ?? 'Return'}
        description="The requester sees your note and can resubmit. The decision is written to the audit log."
        footer={
          <>
            <Button variant="secondary" onClick={() => setReturning(null)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={note.trim().length < 3} loading={decide.isPending} onClick={() => returning && decide.mutate({ params: { id: returning.id }, body: { decision: 'returned', note: note.trim() } })}>
              Return with note
            </Button>
          </>
        }
      >
        <Field label="Note for the requester" hint={note.trim().length < 3 ? 'A note is required so the requester knows what to fix' : undefined}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Attach the drop-out form signed by the student" autoFocus />
        </Field>
      </Dialog>
    </Page>
  );
}
