'use client';

import { teachingMaterialsContract, type TeachMaterialRow } from '@exatech/contracts';
import { Button, Card, cn, Dialog, EmptyState, Field, Icon, Input, Kicker, Seg, Skeleton, Tag, tagVariants, toast } from '@exatech/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { callApi, keyFor, type ApiResult } from '@/lib/api';
import { invalidatePrefixes, useApi } from '@/lib/hooks';
import { addDaysClient, ScreenHeader, todayISTClient } from './parts';
import { UploadDialog } from './upload-dialog';

type Visibility = TeachMaterialRow['visibility'];
type ListData = ApiResult<typeof teachingMaterialsContract.list>;

const NEXT: Record<Visibility, Visibility> = { always: 'fee_gated', fee_gated: 'scheduled', scheduled: 'always' };
const OPTIMISTIC: Record<Visibility, { label: string; tag: TeachMaterialRow['tag'] }> = {
  always: { label: 'Always visible', tag: 'accent' },
  fee_gated: { label: 'Fee-gated', tag: 'outline' },
  scheduled: { label: 'Scheduled', tag: 'neutral' },
};

/** Teacher · Notes & material — per-batch list by syllabus module, visibility cycling, remove with undo, upload. */
export function NotesScreen({ batchId }: { batchId?: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const args = { query: batchId ? { batchId } : {} };
  const key = keyFor(teachingMaterialsContract.list, args);
  const { data, isPending, error } = useApi(teachingMaterialsContract.list, args);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [scheduling, setScheduling] = useState<TeachMaterialRow | null>(null);
  const [releaseOn, setReleaseOn] = useState('');

  const patchItem = (id: string, fn: (m: TeachMaterialRow) => TeachMaterialRow | null) =>
    qc.setQueryData(key, (old: ListData | undefined) => {
      if (!old) return old;
      const groups = old.groups.map((g) => ({ ...g, items: g.items.map((m) => (m.id === id ? fn(m) : m)).filter((m): m is TeachMaterialRow => !!m) })).filter((g) => g.items.length);
      return { ...old, groups, count: groups.reduce((a, g) => a + g.items.length, 0) };
    });

  const setVisibility = async (m: TeachMaterialRow, visibility: Visibility, date?: string) => {
    const label = visibility === 'scheduled' && date ? `Scheduled · ${new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}` : OPTIMISTIC[visibility].label;
    patchItem(m.id, (x) => ({ ...x, visibility, visibilityLabel: label, tag: OPTIMISTIC[visibility].tag, releaseOn: date ?? null }));
    try {
      await callApi(teachingMaterialsContract.visibility, { params: { id: m.id }, body: { visibility, releaseOn: date ?? null } });
      toast(`${m.title} · ${label}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      await invalidatePrefixes(qc, [['teaching', 'materials']]);
    }
  };

  const cycle = (m: TeachMaterialRow) => {
    const next = NEXT[m.visibility];
    if (next === 'scheduled') {
      setReleaseOn(addDaysClient(todayISTClient(), 7));
      setScheduling(m);
      return;
    }
    void setVisibility(m, next);
  };

  const remove = async (m: TeachMaterialRow) => {
    patchItem(m.id, () => null);
    try {
      await callApi(teachingMaterialsContract.remove, { params: { id: m.id } });
      toast(`Removed · ${m.title}`, {
        undo: async () => {
          try {
            await callApi(teachingMaterialsContract.restore, { params: { id: m.id } });
            toast(`Restored · ${m.title}`);
          } catch (err) {
            toast.error((err as Error).message);
          } finally {
            await invalidatePrefixes(qc, [['teaching', 'materials']]);
          }
        },
      });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      await invalidatePrefixes(qc, [['teaching', 'materials']]);
    }
  };

  return (
    <>
      <ScreenHeader
        label="Teacher · Notes"
        kicker={data ? `${data.batchCode ?? '—'} · ${data.count} item${data.count === 1 ? '' : 's'} · by syllabus module` : null}
        title="Notes & material"
        action={
          <Button variant="primary" className="min-h-11" onClick={() => setUploadOpen(true)} disabled={!data?.batches.length}>
            Upload
          </Button>
        }
      />
      {data && data.batches.length > 0 && (
        <Seg
          full
          size="lg"
          aria-label="Batch"
          value={data.batchId ?? ''}
          onChange={(id) => router.replace(`/teacher/notes?batch=${id}`)}
          options={data.batches.map((b) => ({ value: b.id, label: b.label }))}
          className="bg-white"
        />
      )}
      {error && <EmptyState title="Could not load material" body={error.message} />}
      {isPending && Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-[140px]" />)}
      {data && data.groups.length === 0 && (
        <Card tone="white" pad="none">
          <EmptyState className="py-6" title="No material yet" body="Upload notes, slides, worksheets or recordings — organised by syllabus module." />
        </Card>
      )}
      {data?.groups.map((g) => (
        <Card key={g.module} tone="white" pad="none" className="min-w-0" data-testid="material-group">
          <Kicker className="px-3 py-2.5 border-b border-divider">{g.module}</Kicker>
          {g.items.map((m) => (
            <div key={m.id} className="flex items-center gap-2 pl-3 pr-1.5 py-1 border-b border-divider last:border-b-0 min-h-[52px]" data-testid="material-row">
              <Tag variant="neutral" size="sm">
                {m.type}
              </Tag>
              <span className="flex-1 min-w-0 text-sm">
                <span className="block">{m.title}</span>
                <div className="text-[11px] text-neutral-600">
                  {m.meta} · opened {m.opened}
                </div>
              </span>
              <button type="button" title="Tap to change visibility" className="min-h-11 flex items-center border-0 bg-transparent p-0 cursor-pointer font-[inherit]" onClick={() => cycle(m)} aria-label={`Visibility ${m.visibilityLabel} — tap to change`}>
                <span className={cn(tagVariants({ variant: m.tag }), 'text-[11px] min-h-7 items-center')}>{m.visibilityLabel} ⟳</span>
              </button>
              <button type="button" title="Remove" aria-label={`Remove ${m.title}`} className="w-11 h-11 grid place-items-center border-0 bg-transparent p-0 cursor-pointer" onClick={() => void remove(m)}>
                <span className="w-7 h-7 grid place-items-center border border-divider bg-white text-neutral-600">
                  <Icon name="x" size={12} />
                </span>
              </button>
            </div>
          ))}
        </Card>
      ))}
      <div className="text-xs text-neutral-600 text-center">Tap a visibility tag to cycle Always → Fee-gated → Scheduled. Files served through 5-minute signed URLs · PDFs watermarked with the student&apos;s name.</div>

      {data && <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} batches={data.batches} batchId={data.batchId} modules={data.modules} />}
      <Dialog
        open={!!scheduling}
        onOpenChange={(o) => !o && setScheduling(null)}
        kicker="Visibility · scheduled release"
        title={scheduling ? `Release · ${scheduling.title}` : 'Release'}
        width={400}
        footer={
          <>
            <Button variant="secondary" size="lg" onClick={() => setScheduling(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="lg"
              disabled={!releaseOn || releaseOn < todayISTClient()}
              onClick={() => {
                if (scheduling) void setVisibility(scheduling, 'scheduled', releaseOn);
                setScheduling(null);
              }}
            >
              Schedule
            </Button>
          </>
        }
      >
        <Field label="Release on">
          <Input type="date" className="min-h-11" value={releaseOn} min={todayISTClient()} onChange={(e) => setReleaseOn(e.target.value)} />
        </Field>
        <div className="text-[13px] text-neutral-700">Students see the title now; the file unlocks at 08:00 on the release date.</div>
      </Dialog>
    </>
  );
}
