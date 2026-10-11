'use client';

import { salesContract, type LeadCard } from '@exatech/contracts';
import { type LeadStage } from '@exatech/domain';
import { Button, Card, cn, EmptyState, Icon, Page, PageHeader, Seg, Skeleton, Tag } from '@exatech/ui';
import { LayoutGroup, motion, MotionConfig } from 'motion/react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type DragEvent } from 'react';
import { useCan } from '@/components/me-context';
import { useApi } from '@/lib/hooks';
import { NewLeadDialog } from './new-lead-dialog';
import { useStageMove } from './use-stage-move';

/** Drag payload type naming the only column the card may be dropped on. */
const DRAG_TYPE = 'application/x-exa-lead-to-';

/** Sales · Pipeline — seven-stage kanban with one-click advance, drag & drop and undo. */
export function PipelineScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const canCreate = useCan('sales:leads.create');
  const canImport = useCan('sales:import');
  const canMove = useCan('sales:leads.update');
  const pipeline = useApi(salesContract.pipeline, {});
  const move = useStageMove();
  const [newOpen, setNewOpen] = useState(false);
  const [drag, setDrag] = useState<{ id: string; to: LeadStage | null } | null>(null);
  const [over, setOver] = useState<LeadStage | null>(null);

  useEffect(() => {
    if (params.get('new') === '1' && canCreate) setNewOpen(true);
  }, [params, canCreate]);

  const advance = (l: LeadCard) => {
    if (!l.nextStage) return;
    move.mutate({ id: l.id, name: l.name, from: l.stage, to: l.nextStage });
  };

  const onDrop = (stage: LeadStage) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData('text/plain');
    const card = pipeline.data?.columns.flatMap((c) => c.leads).find((l) => l.id === id);
    setDrag(null);
    if (card && card.nextStage === stage) advance(card);
  };

  const data = pipeline.data;
  return (
    <Page label="Sales · Pipeline">
      <PageHeader
        kicker={data?.scopeLabel ?? ' '}
        title={data ? `Pipeline · ${data.openTotal} open` : 'Pipeline'}
        actions={
          <>
            <Seg aria-label="View" value="kanban" onChange={(v) => v === 'table' && router.push('/sales/leads')} options={[{ value: 'kanban', label: 'Kanban' }, { value: 'table', label: 'Table' }]} />
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
      {pipeline.error && (
        <Card>
          <EmptyState title="Could not load the pipeline" body={pipeline.error.message} />
        </Card>
      )}
      <MotionConfig reducedMotion="user" transition={{ type: 'spring', stiffness: 520, damping: 42 }}>
        <LayoutGroup>
          <div className="grid grid-flow-col auto-cols-[minmax(200px,1fr)] gap-2.5 overflow-x-auto pb-2" role="list" aria-label="Pipeline stages">
            {!data &&
              Array.from({ length: 7 }, (_, i) => (
                <div key={i} className="grid gap-2 content-start">
                  <Skeleton className="h-8" />
                  <Skeleton className="h-[104px]" />
                  <Skeleton className="h-[104px]" />
                </div>
              ))}
            {data?.columns.map((col) => {
              const droppable = drag?.to === col.stage;
              const accepts = (e: DragEvent) => droppable || e.dataTransfer.types.includes(`${DRAG_TYPE}${col.stage}`);
              return (
                <section
                  key={col.stage}
                  aria-label={`${col.label} column`}
                  data-stage={col.stage}
                  className={cn('grid gap-2 content-start min-w-0 transition-colors', droppable && 'bg-accent-100/70 outline-1 outline-dashed outline-accent', over === col.stage && droppable && 'bg-accent-200/70')}
                  onDragOver={(e) => {
                    if (accepts(e)) {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      setOver(col.stage);
                    }
                  }}
                  onDragLeave={() => setOver((o) => (o === col.stage ? null : o))}
                  onDrop={onDrop(col.stage)}
                >
                  <div className={cn('flex justify-between items-center gap-2 px-0.5 py-1.5 border-b-2 min-w-0', col.stage === 'won' ? 'border-accent' : col.stage === 'admission_in_progress' ? 'border-accent-500' : 'border-accent-300')}>
                    <span className="font-heading font-semibold text-[15px] truncate">{col.label}</span>
                    <motion.span key={col.count} initial={{ y: -4, opacity: 0.4 }} animate={{ y: 0, opacity: 1 }}>
                      <Tag variant="neutral">{col.count}</Tag>
                    </motion.span>
                  </div>
                  {col.leads.map((l) => {
                    // A card is locked while its own move is on the way to the server.
                    const busy = move.isPending && move.variables?.id === l.id;
                    return (
                    <motion.div key={l.id} layout layoutId={l.id} className="min-w-0">
                      <div
                        draggable={canMove && !!l.nextStage && !busy}
                        aria-busy={busy || undefined}
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/plain', l.id);
                          if (l.nextStage) e.dataTransfer.setData(`${DRAG_TYPE}${l.nextStage}`, l.id);
                          e.dataTransfer.effectAllowed = 'move';
                          setDrag({ id: l.id, to: l.nextStage });
                        }}
                        onDragEnd={() => {
                          setDrag(null);
                          setOver(null);
                        }}
                        data-testid="lead-card"
                        aria-label={l.name}
                        className="min-w-0"
                      >
                        <Card pad="none" className={cn('px-3 py-2.5 gap-1.5 hover:shadow-sm transition-shadow', canMove && l.nextStage && 'cursor-grab active:cursor-grabbing', drag?.id === l.id && 'opacity-60')}>
                          <div className="flex justify-between gap-1.5">
                            <Link href={`/sales/leads?lead=${l.id}`} className="font-medium text-[13px] text-ink no-underline hover:underline underline-offset-2 truncate">
                              {l.name}
                            </Link>
                            <span className="text-[11px] text-accent-700 font-bold tabular">{l.score}</span>
                          </div>
                          <div className="text-xs text-neutral-700 truncate">{l.courseName ?? 'Course not set'}</div>
                          <div className="flex justify-between items-center gap-1.5">
                            <Tag variant="outline" size="sm">
                              {l.source}
                            </Tag>
                            <span className="text-[11px] text-neutral-600 truncate">{l.ownerName}</span>
                          </div>
                          <div className="text-[11px] text-neutral-600 border-t border-divider pt-1.5 flex justify-between items-center gap-1.5">
                            <span className={cn('truncate', l.nextOverdue && 'text-ink font-medium')} title={l.nextLine}>
                              {l.nextLine}
                            </span>
                            {canMove && l.nextStage && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => advance(l)}
                                title="Move to next stage"
                                aria-label={`Move ${l.name} to next stage`}
                                className="flex-none border border-divider bg-white w-6 h-[22px] cursor-pointer grid place-items-center hover:bg-accent-100 hover:border-accent focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-45 disabled:cursor-wait"
                              >
                                <Icon name="arrowRight" size={12} />
                              </button>
                            )}
                          </div>
                        </Card>
                      </div>
                    </motion.div>
                    );
                  })}
                  {col.count > col.leads.length && (
                    <Link href={`/sales/leads?stage=${col.stage}`} className="text-xs text-accent-800 underline underline-offset-[3px] px-1">
                      +{col.count - col.leads.length} more in the table
                    </Link>
                  )}
                  {col.count === 0 && <div className="text-xs text-neutral-500 px-1 py-3 border border-dashed border-divider text-center">No leads</div>}
                </section>
              );
            })}
          </div>
        </LayoutGroup>
      </MotionConfig>
      <NewLeadDialog open={newOpen} onOpenChange={(o) => {
        setNewOpen(o);
        if (!o && params.get('new')) router.replace('/sales/pipeline');
      }} />
    </Page>
  );
}
