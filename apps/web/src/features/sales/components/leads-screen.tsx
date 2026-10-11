'use client';

import { salesContract } from '@exatech/contracts';
import { LEAD_STAGE_LABEL, LEAD_STAGES, type LeadStage } from '@exatech/domain';
import { Button, Card, cn, EmptyState, Input, Page, PageHeader, Popover, Select, Skeleton, Table, TableScroll, Tag, TD, TH } from '@exatech/ui';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useCan, useMe } from '@/components/me-context';
import { useApi } from '@/lib/hooks';
import { FORM_SOURCES, stageTag, useReference } from '../lib';
import { LeadRecord } from './lead-record';
import { NewLeadDialog } from './new-lead-dialog';

interface Filters {
  q: string;
  stage: string;
  courseId: string;
  source: string;
  minScore: string;
}
interface SavedView {
  name: string;
  filters: Filters;
}
const EMPTY: Filters = { q: '', stage: '', courseId: '', source: '', minScore: '' };
const VIEWS_KEY = 'exa:sales:lead-views';

function loadViews(): SavedView[] {
  try {
    const raw = window.localStorage.getItem(VIEWS_KEY);
    return raw ? (JSON.parse(raw) as SavedView[]) : [];
  } catch {
    return [];
  }
}
function storeViews(v: SavedView[]) {
  try {
    window.localStorage.setItem(VIEWS_KEY, JSON.stringify(v));
  } catch {
    /* private mode */
  }
}

/** Sales · Leads — searchable table with saved views and the lead record panel. */
export function LeadsScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const ref = useReference();
  const canCreate = useCan('sales:leads.create');
  const canImport = useCan('sales:import');
  const canAll = useCan('sales:leads.all');
  const me = useMe();
  const [f, setF] = useState<Filters>(() => ({ ...EMPTY, stage: params.get('stage') ?? '' }));
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(params.get('lead'));
  const [newOpen, setNewOpen] = useState(false);
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewName, setViewName] = useState('');
  const [viewsOpen, setViewsOpen] = useState(false);

  useEffect(() => setViews(loadViews()), []);
  useEffect(() => {
    const t = setTimeout(() => setQ(f.q.trim()), 250);
    return () => clearTimeout(t);
  }, [f.q]);
  useEffect(() => {
    const id = params.get('lead');
    if (id) setSelected(id);
  }, [params]);

  const query = useMemo(
    () => ({
      ...(q ? { q } : {}),
      ...(f.stage ? { stage: f.stage as LeadStage } : {}),
      ...(f.courseId ? { courseId: f.courseId } : {}),
      ...(f.source ? { source: f.source } : {}),
      ...(f.minScore ? { minScore: Number(f.minScore) } : {}),
    }),
    [q, f.stage, f.courseId, f.source, f.minScore],
  );
  const leads = useApi(salesContract.leads, { query }, { placeholderData: (prev) => prev });
  const rows = leads.data?.items ?? [];
  // Like the prototype, the record panel shows the first lead until one is picked.
  useEffect(() => {
    if (!selected && rows[0]) setSelected(rows[0].id);
  }, [selected, rows]);

  const select = (id: string) => {
    setSelected(id);
    const sp = new URLSearchParams(params.toString());
    sp.set('lead', id);
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  };
  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const active = Object.entries(f).some(([, v]) => v);

  return (
    <Page label="Sales · Leads">
      <PageHeader
        kicker={leads.data?.scopeLabel ?? ' '}
        title="Leads"
        actions={
          <>
            <Popover
              open={viewsOpen}
              onOpenChange={setViewsOpen}
              width={300}
              trigger={<Button variant="secondary">Saved view ▾</Button>}
            >
              <div className="p-3 grid gap-2">
                {views.length === 0 && <div className="text-xs text-neutral-600">No saved views yet. Set filters, name the view and save it.</div>}
                {views.map((v) => (
                  <div key={v.name} className="flex items-center justify-between gap-2 text-[13px]">
                    <button
                      type="button"
                      className="border-0 bg-transparent p-0 text-left cursor-pointer underline underline-offset-[3px] text-accent-800 font-[inherit]"
                      onClick={() => {
                        setF(v.filters);
                        setViewsOpen(false);
                      }}
                    >
                      {v.name}
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete view ${v.name}`}
                      className="border-0 bg-transparent cursor-pointer text-neutral-500 hover:text-ink"
                      onClick={() => {
                        const next = views.filter((x) => x.name !== v.name);
                        setViews(next);
                        storeViews(next);
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <div className="flex gap-1.5 border-t border-divider pt-2">
                  <Input value={viewName} onChange={(e) => setViewName(e.target.value)} placeholder="Name this view" aria-label="View name" />
                  <Button
                    variant="primary"
                    disabled={!viewName.trim() || !active}
                    onClick={() => {
                      const next = [...views.filter((v) => v.name !== viewName.trim()), { name: viewName.trim(), filters: f }];
                      setViews(next);
                      storeViews(next);
                      setViewName('');
                    }}
                  >
                    Save
                  </Button>
                </div>
                {!active && <div className="text-[11px] text-neutral-600">Set at least one filter to save a view.</div>}
              </div>
            </Popover>
            {canImport && (
              <Link href="/sales/import">
                <Button variant="secondary">Import</Button>
              </Link>
            )}
            {canCreate && (
              <Button variant="primary" onClick={() => setNewOpen(true)}>
                New lead
              </Button>
            )}
          </>
        }
      />
      <div className="flex gap-2 flex-wrap">
        <Input placeholder="Search name or phone" value={f.q} onChange={set('q')} className="max-w-[260px]" aria-label="Search leads" />
        <Select className="w-auto" value={f.stage} onChange={set('stage')} aria-label="Stage" options={[{ value: '', label: 'All stages' }, ...LEAD_STAGES.map((st) => ({ value: st, label: LEAD_STAGE_LABEL[st] }))]} />
        <Select className="w-auto" value={f.courseId} onChange={set('courseId')} aria-label="Course" options={[{ value: '', label: 'All courses' }, ...(ref.data?.courses ?? []).map((c) => ({ value: c.id, label: c.name }))]} />
        <Select className="w-auto" value={f.source} onChange={set('source')} aria-label="Source" options={[{ value: '', label: 'All sources' }, ...FORM_SOURCES, 'Import']} />
        <Select className="w-auto" value={f.minScore} onChange={set('minScore')} aria-label="Minimum score" options={[{ value: '', label: 'Score ≥ 0' }, ...[40, 60, 80].map((n) => ({ value: String(n), label: `Score ≥ ${n}` }))]} />
        {active && (
          <Button variant="ghost" onClick={() => setF(EMPTY)}>
            Clear
          </Button>
        )}
      </div>
      <div className="grid gap-3.5 items-start lg:grid-cols-[minmax(0,1.7fr)_minmax(320px,1fr)]">
        <Card pad="none">
          <TableScroll minWidth={720}>
            <Table>
              <thead>
                <tr>
                  <TH>Lead</TH>
                  <TH>Course interest</TH>
                  <TH>Source</TH>
                  <TH>Stage</TH>
                  <TH>Score</TH>
                  <TH>Owner</TH>
                  <TH>Next</TH>
                </tr>
              </thead>
              <tbody>
                {leads.isPending &&
                  Array.from({ length: 8 }, (_, i) => (
                    <tr key={i}>
                      <TD colSpan={7}>
                        <Skeleton className="h-8" />
                      </TD>
                    </tr>
                  ))}
                {rows.map((l) => (
                  <tr
                    key={l.id}
                    onClick={() => select(l.id)}
                    aria-selected={selected === l.id}
                    className={cn('cursor-pointer hover:bg-ink/4', selected === l.id && 'bg-accent-100 hover:bg-accent-100')}
                  >
                    <TD className="whitespace-nowrap">
                      <b className="font-medium">{l.name}</b>
                      <div className="text-xs text-neutral-600 tabular">{l.phoneDisplay}</div>
                    </TD>
                    <TD>{l.courseName ?? '—'}</TD>
                    <TD>
                      <Tag variant="outline">{l.source}</Tag>
                    </TD>
                    <TD>
                      <Tag variant={stageTag(l.stage)}>{l.stageLabel}</Tag>
                    </TD>
                    <TD className="font-semibold text-accent-700 tabular">{l.score}</TD>
                    <TD>{l.ownerName}</TD>
                    <TD className={cn('text-xs text-neutral-700 max-w-[200px] truncate', l.nextOverdue && 'text-ink font-medium')} title={l.nextLine}>
                      {l.nextLine}
                    </TD>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
          {!leads.isPending && rows.length === 0 && <EmptyState title="No leads match" body={active ? 'Clear the filters or try another search.' : 'Create a lead or import a file to start.'} />}
          {leads.error && <EmptyState title="Could not load leads" body={leads.error.message} />}
          {leads.data && leads.data.total > rows.length && (
            <div className="px-4 py-2 text-xs text-neutral-600 border-t border-divider">
              Showing {rows.length} of {leads.data.total.toLocaleString('en-IN')} — refine the search to narrow down.
            </div>
          )}
        </Card>
        <LeadRecord id={selected} />
      </div>
      <NewLeadDialog open={newOpen} onOpenChange={setNewOpen} onCreated={(d) => (d.ownerId === me.user.id || canAll) && select(d.id)} />
    </Page>
  );
}
