'use client';

import { teachingMarksContract, type TeachExam } from '@exatech/contracts';
import { canSubmitMarks, evaluateMarkRow, examStats } from '@exatech/domain';
import { Button, Card, CardTitle, cn, EmptyState, Field, Input, Issue, Kicker, Select, Skeleton, Tag, toast } from '@exatech/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi, keyFor } from '@/lib/api';
import { useApi, useApiMutation } from '@/lib/hooks';
import { ExamDialog, ImportCsvDialog } from './exam-dialogs';
import { ScreenHeader } from './parts';

const fmt = (n: number) => String(Math.round(n * 10) / 10);
const cellKey = (enr: string, comp: string) => `${enr}|${comp}`;
const NUM = /^\d+(\.\d+)?$/;

function parse(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  return NUM.test(t) ? Number(t) : Number.NaN;
}

/** Teacher · Marks entry — exam picker, per-component grid with debounced autosave, fill 0, CSV import, submit / recall. */
export function MarksScreen({ examId: initialExam }: { examId?: string }) {
  const router = useRouter();
  const list = useApi(teachingMarksContract.exams, {});
  const [selected, setSelected] = useState<string | undefined>(initialExam);
  const examId = selected ?? list.data?.items[0]?.id;
  const exam = useApi(teachingMarksContract.exam, { params: { id: examId ?? '00000000-0000-0000-0000-000000000000' } }, { enabled: !!examId });
  const [examOpen, setExamOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const choose = (id: string) => {
    setSelected(id);
    router.replace(`/teacher/marks?exam=${id}`, { scroll: false });
  };

  const e = exam.data && exam.data.id === examId ? exam.data : null;
  return (
    <>
      <ScreenHeader
        label="Teacher · Marks"
        kicker={e ? e.kicker : list.data && !list.data.items.length ? 'No exams yet' : null}
        title="Marks entry"
        action={
          <Button variant="primary" className="min-h-11" onClick={() => setExamOpen(true)} disabled={!list.data?.batches.length}>
            New exam
          </Button>
        }
      />
      {list.error && <EmptyState title="Could not load exams" body={list.error.message} />}
      {list.isPending && <Skeleton className="h-[66px]" />}
      {list.data && list.data.items.length > 0 && (
        <Field label="Exam · batch">
          <Select tone="white" className="min-h-11" value={examId ?? ''} onChange={(ev) => choose(ev.target.value)} options={list.data.items.map((x) => ({ value: x.id, label: x.label }))} />
        </Field>
      )}
      {list.data && list.data.items.length === 0 && (
        <Card tone="white" pad="none">
          <EmptyState className="py-6" title="No exams yet" body="Create an exam for one of your batches — the roster loads and it appears on students' timetable." />
        </Card>
      )}
      {exam.error && <EmptyState title="Could not load the exam" body={exam.error.message} />}
      {examId && !e && !exam.error && <Skeleton className="h-[420px]" />}
      {e && <Grid key={e.id} exam={e} onImport={() => setImportOpen(true)} />}
      {list.data && <ExamDialog open={examOpen} onOpenChange={setExamOpen} batches={list.data.batches} exams={list.data.items} onCreated={choose} />}
      {e && <ImportCsvDialog exam={e} open={importOpen} onOpenChange={setImportOpen} onImported={() => undefined} />}
    </>
  );
}

function Grid({ exam, onImport }: { exam: TeachExam; onImport: () => void }) {
  const qc = useQueryClient();
  const key = keyFor(teachingMarksContract.exam, { params: { id: exam.id } });
  const [dirty, setDirty] = useState<Record<string, string>>({});
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [saving, setSaving] = useState(0);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const serverValue = useCallback((enr: string, ci: number) => exam.rows.find((r) => r.enrollmentId === enr)?.values[ci] ?? null, [exam]);
  const display = (enr: string, ci: number) => {
    const k = cellKey(enr, exam.components[ci]!.id);
    if (k in dirty) return dirty[k]!;
    const v = serverValue(enr, ci);
    return v == null ? '' : fmt(v);
  };

  const save = useCallback(
    async (keys: string[]) => {
      const cells: { enrollmentId: string; componentId: string; value: number | null }[] = [];
      const sent: Record<string, string> = {};
      for (const k of keys) {
        const raw = dirtyRef.current[k];
        if (raw === undefined) continue;
        const v = parse(raw);
        if (v != null && Number.isNaN(v)) continue; // not a number: stays dirty, shown as invalid
        const [enrollmentId, componentId] = k.split('|') as [string, string];
        cells.push({ enrollmentId, componentId, value: v });
        sent[k] = raw;
      }
      if (!cells.length) return;
      setSaving((n) => n + 1);
      try {
        const res = await callApi(teachingMarksContract.save, { params: { id: exam.id }, body: { cells } });
        qc.setQueryData(key, (old: TeachExam | undefined) => {
          if (!old) return old;
          return {
            ...old,
            rows: old.rows.map((r) => ({
              ...r,
              values: r.values.map((val, ci) => {
                const c = cells.find((x) => x.enrollmentId === r.enrollmentId && x.componentId === old.components[ci]!.id);
                return c ? c.value : val;
              }),
            })),
          };
        });
        setDirty((d) => {
          const next = { ...d };
          for (const [k, raw] of Object.entries(sent)) if (next[k] === raw) delete next[k];
          return next;
        });
        setSavedAt(new Date(Date.parse(String(res.savedAt)) + 330 * 60_000).toISOString().slice(11, 16));
      } catch (err) {
        toast.error((err as Error).message);
      } finally {
        setSaving((n) => n - 1);
      }
    },
    [exam.id, key, qc],
  );

  const flushAll = useCallback(async () => {
    for (const t of Object.values(timers.current)) clearTimeout(t);
    timers.current = {};
    await save(Object.keys(dirtyRef.current));
  }, [save]);

  useEffect(
    () => () => {
      for (const t of Object.values(timers.current)) clearTimeout(t);
    },
    [],
  );

  const change = (enr: string, compId: string, raw: string) => {
    const k = cellKey(enr, compId);
    const clean = raw.replace(/[^\d.]/g, '');
    setDirty((d) => ({ ...d, [k]: clean }));
    dirtyRef.current = { ...dirtyRef.current, [k]: clean };
    if (timers.current[k]) clearTimeout(timers.current[k]);
    timers.current[k] = setTimeout(() => {
      delete timers.current[k];
      void save([k]);
    }, 600);
  };

  const defs = useMemo(() => exam.components.map((c) => ({ name: c.name, max: c.max })), [exam.components]);
  const grid = exam.rows.map((r) => exam.components.map((_, ci) => parse(display(r.enrollmentId, ci))));
  const evals = grid.map((vals) => evaluateMarkRow(vals, defs));
  const incomplete = evals.filter((x) => !x.complete).length;
  const overRows = evals.filter((x) => x.invalid).length;
  const entered = grid.some((vals) => vals.some((v) => v != null));
  const stats = examStats(
    grid.map((vals) => vals.map((v) => (v != null && Number.isNaN(v) ? null : v))),
    defs,
  );
  const check = canSubmitMarks(grid, defs);
  const pending = Object.keys(dirty).length > 0 || saving > 0;
  const hint = !entered
    ? 'No marks yet · type them in or import a CSV'
    : [
        incomplete || overRows ? [incomplete ? `${incomplete} row${incomplete > 1 ? 's' : ''} incomplete` : null, overRows ? `${overRows} over max` : null].filter(Boolean).join(' · ') : `All ${exam.rows.length} rows complete · ready to submit`,
        saving ? 'saving…' : savedAt ? `saved ${savedAt}` : 'drafts autosave',
      ].join(' · ');

  const fillZero = useApiMutation(teachingMarksContract.fillZero, { invalidate: [['teaching']], success: (d) => (d.filled ? `Filled ${d.filled} empty cell${d.filled > 1 ? 's' : ''} with 0` : 'No empty cells') });
  const submit = useApiMutation(teachingMarksContract.submit, { invalidate: [['teaching']], success: 'Submitted for publishing · Branch Admin notified' });
  const recall = useApiMutation(teachingMarksContract.recall, { invalidate: [['teaching']], success: 'Recalled to draft' });
  const locked = !exam.editable;

  return (
    <>
      <div className="flex justify-between items-center gap-2">
        <CardTitle>{exam.name}</CardTitle>
        <Tag variant={exam.tag} data-testid="exam-status">
          {exam.statusLabel}
        </Tag>
      </div>
      {exam.returnNote && (
        <Card tone="ink" pad="md" className="gap-1" data-testid="return-note">
          <Kicker className="text-ink">Returned by the Branch Admin · fix and submit again</Kicker>
          <div className="text-[13px]">{exam.returnNote}</div>
        </Card>
      )}
      <Card tone="white" pad="none" className="min-w-0">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="text-left text-[11px] tracking-[0.08em] uppercase text-ink/60 font-normal px-[6.8px] py-[6.8px] pl-3 border-b border-divider">Student</th>
                {exam.components.map((c) => (
                  <th key={c.id} className="text-center text-[11px] tracking-[0.08em] uppercase text-ink/60 font-normal px-[6.8px] py-[6.8px] border-b border-divider whitespace-nowrap">
                    {c.name} · {fmt(c.max)}
                  </th>
                ))}
                <th className="text-right text-[11px] tracking-[0.08em] uppercase text-ink/60 font-normal px-[6.8px] py-[6.8px] pr-3 border-b border-divider whitespace-nowrap">/ {fmt(exam.maxTotal)}</th>
              </tr>
            </thead>
            <tbody>
              {exam.rows.map((r, ri) => {
                const ev = evals[ri]!;
                return (
                  <tr key={r.enrollmentId} data-testid="marks-row">
                    <td className="pl-3 pr-1.5 py-1.5 border-b border-ink/8 font-medium">
                      {r.name}
                      <div className="text-[10px] text-neutral-600 font-mono font-normal">{r.admissionNo ?? '—'}</div>
                    </td>
                    {exam.components.map((c, ci) => {
                      const raw = display(r.enrollmentId, ci);
                      const v = parse(raw);
                      const bad = ev.overMax[ci] || (v != null && Number.isNaN(v));
                      return (
                        <td key={c.id} className="text-center px-1 py-1.5 border-b border-ink/8">
                          <Input
                            inputMode="decimal"
                            value={raw}
                            disabled={locked}
                            placeholder="–"
                            invalid={bad}
                            aria-label={`${r.name} ${c.name}`}
                            onChange={(ev2) => change(r.enrollmentId, c.id, ev2.target.value)}
                            onBlur={() => {
                              const k = cellKey(r.enrollmentId, c.id);
                              if (timers.current[k]) {
                                clearTimeout(timers.current[k]);
                                delete timers.current[k];
                                void save([k]);
                              }
                            }}
                            className={cn('w-[58px] min-h-10 text-center px-0.5 bg-white', bad && 'bg-white')}
                          />
                        </td>
                      );
                    })}
                    <td className={cn('text-right pr-3 py-1.5 border-b border-ink/8 tabular font-semibold', ev.invalid ? 'text-ink' : !ev.complete ? 'text-neutral-500' : '')} data-testid="marks-total">
                      {ev.invalid ? '!' : !ev.complete ? '…' : fmt(ev.total)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {exam.rows.length === 0 && <EmptyState title="Nobody on this roster" body="The batch has no active students." />}
        </div>
      </Card>
      <div className="text-xs text-neutral-600" data-testid="marks-hint">
        {hint}
      </div>
      {exam.editable && (
        <>
          <div className="flex gap-1.5">
            <Button
              variant="secondary"
              size="lg"
              className="flex-1 bg-white"
              loading={fillZero.isPending}
              onClick={async () => {
                await flushAll();
                fillZero.mutate({ params: { id: exam.id } });
              }}
            >
              Fill empty with 0
            </Button>
            <Button
              variant="secondary"
              size="lg"
              className="flex-1 bg-white"
              onClick={async () => {
                await flushAll();
                onImport();
              }}
            >
              Import CSV
            </Button>
          </div>
          {!check.ok && entered && <Issue kind="needed">Submit needs every row complete and within the maximum — {check.reason?.toLowerCase()}</Issue>}
          <Button
            variant="primary"
            size="xl"
            blueprint
            disabled={!check.ok || pending}
            loading={submit.isPending}
            onClick={async () => {
              await flushAll();
              submit.mutate({ params: { id: exam.id } });
            }}
          >
            Submit for publishing · avg {stats.average == null ? '—' : fmt(stats.average)}
          </Button>
        </>
      )}
      {exam.status === 'submitted' && (
        <>
          <div className="text-[13px] text-neutral-700">Waiting for the Branch Admin to publish. Students and parents see marks only once published.</div>
          <Button variant="secondary" size="lg" className="bg-white" loading={recall.isPending} onClick={() => recall.mutate({ params: { id: exam.id } })}>
            Recall to draft
          </Button>
        </>
      )}
      {exam.status === 'published' && <div className="text-[13px] text-neutral-700">Published marks are read-only — corrections need a Branch Admin override with a reason.</div>}
    </>
  );
}
