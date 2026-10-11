'use client';

import { teachingAssignmentsContract, type TeachAssignmentCard } from '@exatech/contracts';
import { Bar, Button, Card, CardMeta, CardTitle, EmptyState, Kicker, Seg, Skeleton, Tag } from '@exatech/ui';
import { useState } from 'react';
import { useApi } from '@/lib/hooks';
import { ExtendDialog, GradeDialog, NewAssignmentDialog, RemindDialog } from './assignment-dialogs';
import { ScreenHeader } from './parts';

/** Teacher · Assignments — to-grade count, per-batch filter, progress cards, grade / remind / extend, new assignment. */
export function AssignmentsScreen() {
  const [batch, setBatch] = useState('all');
  const { data, isPending, error } = useApi(teachingAssignmentsContract.list, { query: batch === 'all' ? {} : { batchId: batch } });
  const [newOpen, setNewOpen] = useState(false);
  const [grading, setGrading] = useState<string | null>(null);
  const [reminding, setReminding] = useState<TeachAssignmentCard | null>(null);
  const [extending, setExtending] = useState<TeachAssignmentCard | null>(null);
  const batches = data?.batches ?? [];

  return (
    <>
      <ScreenHeader
        label="Teacher · Assignments"
        kicker={data ? `${data.toGrade} to grade` : null}
        title="Assignments"
        action={
          <Button variant="primary" className="min-h-11" onClick={() => setNewOpen(true)} disabled={!batches.length}>
            New
          </Button>
        }
      />
      {batches.length > 0 && (
        <Seg full size="lg" aria-label="Batch" value={batch} onChange={setBatch} options={[{ value: 'all', label: 'All' }, ...batches.map((b) => ({ value: b.id, label: b.code }))]} className="bg-white" />
      )}
      {error && <EmptyState title="Could not load assignments" body={error.message} />}
      {isPending && Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-[170px]" />)}
      {data?.items.length === 0 && (
        <Card tone="white" pad="none">
          <EmptyState className="py-6" title="No assignments yet" body="Publish one to a batch — students see it in their Work tab and you grade submissions here." />
        </Card>
      )}
      {data?.items.map((a) => (
        <Card key={a.id} tone="white" className="p-3.5 gap-2" data-testid="assignment-card">
          <div className="flex justify-between gap-2">
            <Kicker>
              {a.batchCode} · due {a.dueLabel} · {a.max} marks
            </Kicker>
            <Tag variant={a.tagVariant}>{a.tag}</Tag>
          </div>
          <CardTitle>{a.title}</CardTitle>
          <Bar value={a.pct} height={6} />
          <CardMeta className="text-xs text-neutral-600">{a.meta}</CardMeta>
          <div className="flex gap-1.5 flex-wrap">
            {a.toGrade > 0 && (
              <Button variant="primary" size="lg" className="flex-1" onClick={() => setGrading(a.id)}>
                Grade {a.toGrade}
              </Button>
            )}
            <Button variant="secondary" size="lg" className="flex-1" disabled={a.notSubmitted === 0} onClick={() => setReminding(a)}>
              Remind {a.notSubmitted}
            </Button>
            <Button variant="ghost" size="lg" onClick={() => setExtending(a)}>
              Extend
            </Button>
          </div>
        </Card>
      ))}
      <NewAssignmentDialog open={newOpen} onOpenChange={setNewOpen} batches={batches} defaultBatchId={batch === 'all' ? undefined : batch} />
      <GradeDialog assignmentId={grading} onOpenChange={(o) => !o && setGrading(null)} />
      <RemindDialog a={reminding} onOpenChange={(o) => !o && setReminding(null)} />
      <ExtendDialog a={extending} onOpenChange={(o) => !o && setExtending(null)} />
    </>
  );
}
