'use client';

import { teachingMarksContract, type TeachBatch, type TeachExam, type TeachExamOption, type TeachImportResult } from '@exatech/contracts';
import { Button, Dialog, Field, Icon, Input, Issue, Kicker, Select, Textarea } from '@exatech/ui';
import { useEffect, useState } from 'react';
import { callApi } from '@/lib/api';
import { useApiMutation } from '@/lib/hooks';
import { NeededList } from './parts';

/* ───────────────────────── New exam ───────────────────────── */

interface CompRow {
  n: string;
  max: string;
}

export function ExamDialog({
  open,
  onOpenChange,
  batches,
  exams,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  batches: TeachBatch[];
  exams: TeachExamOption[];
  onCreated: (id: string) => void;
}) {
  const [batchId, setBatchId] = useState('');
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [comps, setComps] = useState<CompRow[]>([]);
  useEffect(() => {
    if (!open) return;
    setBatchId(batches[0]?.id ?? '');
    setDate('');
    setName('');
    setComps([
      { n: 'Theory', max: '60' },
      { n: 'Practical', max: '40' },
    ]);
  }, [open, batches]);
  const create = useApiMutation(teachingMarksContract.create, {
    invalidate: [['teaching']],
    success: 'Exam created · roster loaded · on students’ timetable',
    onSuccess: (d) => {
      onOpenChange(false);
      onCreated(d.id);
    },
  });
  const batch = batches.find((b) => b.id === batchId);
  const total = comps.reduce((a, c) => a + (Number(c.max) || 0), 0);
  const dup = exams.some((e) => e.batchId === batchId && e.name.trim().toLowerCase() === name.trim().toLowerCase());
  const names = comps.map((c) => c.n.trim().toLowerCase()).filter(Boolean);
  const issues = [
    ...(!batchId ? ['Batch'] : []),
    ...(!date ? ['Exam date'] : []),
    ...(name.trim().length < 3 ? ['Exam name'] : dup ? [`“${name.trim()}” already exists for ${batch?.code ?? 'this batch'} — pick another name`] : []),
    ...(comps.some((c) => !c.n.trim()) ? ['A name for every component'] : []),
    ...(comps.some((c) => !(Number(c.max) > 0)) ? ['Max marks for every component'] : []),
    ...(new Set(names).size !== names.length ? ['Different names for the components'] : []),
  ];
  const setComp = (i: number, patch: Partial<CompRow>) => setComps((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      kicker="Marks · new exam"
      title="Create exam"
      width={520}
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={issues.length > 0}
            loading={create.isPending}
            onClick={() => create.mutate({ body: { batchId, date, name: name.trim(), components: comps.map((c) => ({ name: c.n.trim(), max: Number(c.max) })) } })}
          >
            Create exam
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Batch">
          <Select className="min-h-11" value={batchId} onChange={(e) => setBatchId(e.target.value)} options={batches.map((b) => ({ value: b.id, label: b.code }))} />
        </Field>
        <Field label="Date">
          <Input type="date" className="min-h-11" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Exam name" className="col-span-2">
          <Input className="min-h-11" value={name} onChange={(e) => setName(e.target.value)} placeholder="Module 3 · Paid media" autoFocus maxLength={120} invalid={dup} />
        </Field>
      </div>
      <Kicker>Components · total {total}</Kicker>
      {comps.map((c, i) => (
        <div key={i} className="grid grid-cols-[1fr_90px_44px] gap-2">
          <Input className="min-h-11" value={c.n} onChange={(e) => setComp(i, { n: e.target.value })} placeholder="Component name" aria-label={`Component ${i + 1} name`} maxLength={60} />
          <Input
            className="min-h-11 text-center"
            inputMode="decimal"
            value={c.max}
            onChange={(e) => setComp(i, { max: e.target.value.replace(/[^\d.]/g, '') })}
            placeholder="Max"
            aria-label={`Component ${i + 1} max`}
          />
          <button
            type="button"
            title="Remove"
            aria-label={`Remove component ${i + 1}`}
            disabled={comps.length <= 1}
            onClick={() => setComps((cs) => cs.filter((_, j) => j !== i))}
            className="border border-divider bg-white cursor-pointer grid place-items-center disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
      {comps.length < 4 && (
        <Button variant="ghost" className="justify-start min-h-11" onClick={() => setComps((cs) => [...cs, { n: '', max: '' }])}>
          + Add component
        </Button>
      )}
      <div className="grid gap-1">
        <NeededList items={issues} />
        {issues.length === 0 && <Issue kind="ok">Roster loads for the batch · exam appears on students&apos; timetable · marks stay draft until you submit</Issue>}
      </div>
    </Dialog>
  );
}

/* ───────────────────────── CSV import ───────────────────────── */

export function ImportCsvDialog({ exam, open, onOpenChange, onImported }: { exam: TeachExam; open: boolean; onOpenChange: (o: boolean) => void; onImported: () => void }) {
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<TeachImportResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setCsv('');
      setPreview(null);
      setPreviewError(null);
    }
  }, [open]);
  useEffect(() => {
    if (!open || !csv.trim()) {
      setPreview(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      callApi(teachingMarksContract.importCsv, { params: { id: exam.id }, body: { csv, dryRun: true } })
        .then((r) => live && (setPreview(r), setPreviewError(null)))
        .catch((err: Error) => live && setPreviewError(err.message));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [csv, open, exam.id]);
  const apply = useApiMutation(teachingMarksContract.importCsv, {
    invalidate: [['teaching']],
    success: (d) => `Imported ${d.cells} mark${d.cells === 1 ? '' : 's'} for ${d.matched} student${d.matched === 1 ? '' : 's'} · still a draft`,
    onSuccess: () => {
      onOpenChange(false);
      onImported();
    },
  });
  const columns = ['admission_no', ...exam.components.map((c) => c.name)].join(', ');

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      kicker={`Marks · ${exam.batchCode} · ${exam.name}`}
      title="Import CSV"
      width={520}
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" disabled={!preview || preview.cells === 0} loading={apply.isPending} onClick={() => apply.mutate({ params: { id: exam.id }, body: { csv, dryRun: false } })}>
            Import {preview?.cells ?? 0} marks
          </Button>
        </>
      }
    >
      <div className="text-[13px] text-neutral-700">
        Columns: <span className="font-mono text-xs">{columns}</span> — one row per student, matched by admission number. Empty cells are left as they are.
      </div>
      <Field label="CSV file">
        <Input
          type="file"
          accept=".csv,text/csv"
          className="min-h-11"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setCsv(await f.text());
          }}
          data-testid="marks-csv-file"
        />
      </Field>
      <Field label="…or paste it">
        <Textarea value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={`${columns}\nTVM-DM-2027-00142,52,36`} className="font-mono text-xs min-h-[110px]" />
      </Field>
      {previewError && <Issue kind="blocked">{previewError}</Issue>}
      {preview && (
        <div className="grid gap-1" data-testid="marks-csv-preview">
          <Issue kind={preview.cells ? 'ok' : 'blocked'}>
            {preview.rows} rows · {preview.matched} matched · {preview.cells} marks to import{preview.overMax ? ` · ${preview.overMax} over max (highlighted after import)` : ''}
          </Issue>
          {preview.missingColumns.length > 0 && <Issue kind="needed">Missing columns: {preview.missingColumns.join(', ')}</Issue>}
          {preview.unknown.length > 0 && (
            <Issue kind="needed">
              Unknown admission numbers: {preview.unknown.slice(0, 6).join(', ')}
              {preview.unknown.length > 6 ? ` +${preview.unknown.length - 6} more` : ''}
            </Issue>
          )}
        </div>
      )}
    </Dialog>
  );
}
