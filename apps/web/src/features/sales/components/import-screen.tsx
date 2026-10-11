'use client';

import { buildPath, IMPORT_TARGET_LABEL, IMPORT_TARGETS, salesContract, type ImportJob } from '@exatech/contracts';
import { formatPhone, isValidEmail, normalizePhone } from '@exatech/domain';
import { Bar, Button, buttonVariants, Card, CardBody, CardMeta, CardTitle, cn, Field, Icon, Issue, Kicker, Page, PageHeader, Radio, Select, Spinner, Stat, Table, TableScroll, Tag, TD, TH } from '@exatech/ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { callApi, uploadFile, type ApiError } from '@/lib/api';
import { invalidatePrefixes, useApi, useApiMutation } from '@/lib/hooks';
import { plural, useReference } from '../lib';

type Target = (typeof IMPORT_TARGETS)[number];
const STEPS = ['Upload', 'Map & preview', 'Validate & dedupe', 'Run import'];
const ORDER: Target[] = ['name', 'phone', 'email', 'course', 'campaign', 'source', 'branch'];

function stepOf(job: ImportJob | null): number {
  if (!job) return 1;
  if (job.status === 'uploaded') return 2;
  if (job.status === 'validated') return 3;
  return 4;
}

/** Sales · Import leads — upload, map & preview, validate & dedupe, run as a background job. */
export function ImportScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const qc = useQueryClient();
  const ref = useReference();
  const [job, setJob] = useState<ImportJob | null>(null);
  const [step, setStep] = useState(1);
  const [preview, setPreview] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, Target>>({});
  const [dup, setDup] = useState<'merge' | 'skip' | 'create'>('merge');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const adopt = (j: ImportJob, s?: number) => {
    setJob(j);
    if (j.preview) setPreview(j.preview);
    setMapping(Object.fromEntries(j.headers.map((h) => [h, (j.mapping[h] ?? 'skip') as Target])));
    setDup(j.dupStrategy);
    setStep(s ?? stepOf(j));
    setError(null);
    const sp = new URLSearchParams(params.toString());
    sp.set('job', j.id);
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  };

  // Resume a job from the URL (e.g. after reload).
  const resumeId = params.get('job');
  const resume = useApi(salesContract.getImport, { params: { id: resumeId ?? '' } }, { enabled: !!resumeId && !job });
  useEffect(() => {
    if (resume.data && !job) adopt(resume.data);
  }, [resume.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live progress while the job runs.
  const running = !!job && (job.status === 'queued' || job.status === 'running');
  const poll = useApi(salesContract.getImport, { params: { id: job?.id ?? '' } }, { enabled: running, refetchInterval: running ? 600 : false });
  useEffect(() => {
    if (poll.data && job && poll.data.id === job.id) {
      setJob(poll.data);
      if (poll.data.status === 'completed') void invalidatePrefixes(qc, [['sales']]);
    }
  }, [poll.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const stored = await uploadFile(file, 'import');
      const j = await callApi(salesContract.createImport, { body: { fileId: stored.id } });
      adopt(j, 2);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setUploading(false);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) void upload(f);
  };

  const validate = useApiMutation(salesContract.validateImport, { toastError: false, onSuccess: (j) => adopt(j, 3), onError: (e) => setError(e.message) });
  const run = useApiMutation(salesContract.runImport, { toastError: false, onSuccess: (j) => adopt(j, 4), onError: (e) => setError(e.message) });

  const reset = () => {
    setJob(null);
    setPreview([]);
    setMapping({});
    setStep(1);
    setError(null);
    router.replace(pathname, { scroll: false });
  };

  // Preview columns follow the mapping; invalid cells are marked like the validator would.
  const courses = ref.data?.courses ?? [];
  const cols = useMemo(() => ORDER.map((t) => ({ t, idx: job?.headers.findIndex((h) => mapping[h] === t) ?? -1 })).filter((c) => c.idx >= 0), [job, mapping]);
  const cellState = (t: Target, v: string): { text: string; bad: boolean } => {
    const raw = v.trim();
    if (t === 'phone') {
      const p = normalizePhone(raw);
      return p ? { text: formatPhone(p), bad: false } : { text: raw || '—', bad: true };
    }
    if (t === 'email') return raw ? { text: raw, bad: !isValidEmail(raw) } : { text: '—', bad: false };
    if (t === 'name') return { text: raw || '—', bad: raw.length < 2 };
    if (t === 'course' && raw) {
      const x = raw.toLowerCase().replace(/[^a-z]/g, '');
      const ok = courses.some((c) => c.code.toLowerCase() === raw.toLowerCase() || c.name.toLowerCase().replace(/[^a-z]/g, '').includes(x) || x.includes(c.name.toLowerCase().replace(/[^a-z]/g, '')));
      return { text: raw, bad: !ok };
    }
    return { text: raw || '—', bad: false };
  };
  const mapped = Object.values(mapping);
  const missingRequired = (['name', 'phone'] as Target[]).filter((t) => !mapped.includes(t));
  const dupTargets = mapped.filter((t, i) => t !== 'skip' && mapped.indexOf(t) !== i);
  const errorsHref = job ? buildPath(salesContract.importErrorsPath, { id: job.id }) : '#';
  const v = job?.validation;

  return (
    <Page label="Sales · Import leads">
      <PageHeader kicker="Background job · error report downloadable" title="Import leads" />
      <ol className="flex border border-divider m-0 p-0 list-none overflow-x-auto" aria-label="Import steps">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const state = n < step ? 'done' : n === step ? 'current' : 'todo';
          return (
            <li
              key={label}
              aria-current={state === 'current' ? 'step' : undefined}
              className={cn(
                'flex-1 min-w-[150px] px-3.5 py-2.5 text-[13px] border-r border-divider last:border-r-0 flex gap-2 items-center',
                state === 'current' && 'bg-accent text-white',
                state === 'done' && 'bg-accent-100 text-accent-800',
                state === 'todo' && 'text-neutral-600',
              )}
            >
              <span className="w-5 h-5 border border-current grid place-items-center text-[11px] font-semibold">{state === 'done' ? '✓' : n}</span>
              {label}
            </li>
          );
        })}
      </ol>
      {error && <Issue kind="blocked">{error}</Issue>}

      {step === 1 && (
        <Card
          tone="dashed"
          className={cn('p-10 gap-2.5 items-center text-center', dragOver && 'bg-accent-100 border-accent')}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <Icon name="upload" size={28} className="text-accent" />
          <CardTitle>Drop a CSV or XLSX</CardTitle>
          <CardBody>Up to 10,000 rows · processed in under 60 s · phone validated as E.164</CardBody>
          <div className="flex gap-2 flex-wrap justify-center">
            <a href={salesContract.importTemplatePath} download className={buttonVariants({ variant: 'secondary' })}>
              Download template
            </a>
            <Button variant="primary" loading={uploading} onClick={() => fileRef.current?.click()}>
              Choose file
            </Button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            aria-label="Lead file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = '';
            }}
          />
        </Card>
      )}

      {step === 2 && job && (
        <div className="grid gap-3.5 items-start" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))' }}>
          <Card className="gap-2.5 lg:max-w-[360px]">
            <CardTitle>Map columns</CardTitle>
            {job.headers.map((h) => (
              <Field key={h} label={`${h} →`}>
                <Select value={mapping[h] ?? 'skip'} onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value as Target }))} options={IMPORT_TARGETS.map((t) => ({ value: t, label: IMPORT_TARGET_LABEL[t] }))} />
              </Field>
            ))}
            {missingRequired.length > 0 && <Issue kind="needed">Map a column to {missingRequired.join(' and ')}</Issue>}
            {dupTargets.length > 0 && <Issue kind="blocked">{dupTargets.join(', ')} is mapped twice</Issue>}
            <Button variant="ghost" className="justify-start" onClick={reset}>
              Choose another file
            </Button>
          </Card>
          <Card pad="none" className="min-w-0 lg:col-span-2">
            <div className="flex justify-between items-center gap-2 px-4 py-3 border-b border-divider flex-wrap">
              <CardTitle>
                Preview · first {Math.min(50, preview.length || job.totalRows)} of {job.totalRows.toLocaleString('en-IN')} rows
              </CardTitle>
              <Button variant="primary" loading={validate.isPending} disabled={missingRequired.length > 0 || dupTargets.length > 0} onClick={() => validate.mutate({ params: { id: job.id }, body: { mapping } })}>
                Validate →
              </Button>
            </div>
            <TableScroll minWidth={620}>
              <Table>
                <thead>
                  <tr>
                    <TH>#</TH>
                    {cols.map((c) => (
                      <TH key={c.t}>{IMPORT_TARGET_LABEL[c.t].replace(' (E.164)', '')}</TH>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.map((r, i) => (
                    <tr key={i}>
                      <TD className="text-neutral-500 tabular">{i + 1}</TD>
                      {cols.map((c) => {
                        const st = cellState(c.t, r[c.idx] ?? '');
                        return (
                          <TD key={c.t} className={cn('whitespace-nowrap', st.bad && 'text-ink underline decoration-wavy decoration-ink/70 underline-offset-[3px]')} title={st.bad ? `Invalid ${c.t}` : undefined} data-invalid={st.bad || undefined}>
                            {st.text}
                          </TD>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableScroll>
            {preview.length === 0 && <div className="px-4 py-6 text-[13px] text-neutral-600">Preview is shown right after upload — validate to check every row.</div>}
          </Card>
        </div>
      )}

      {step === 3 && job && v && (
        <>
          <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            <Stat label="Rows" value={job.totalRows.toLocaleString('en-IN')} />
            <Stat label="Valid · will create" value={<span className="text-accent-700">{v.valid.toLocaleString('en-IN')}</span>} />
            <Stat label="Duplicates (phone/email)" value={v.duplicates.toLocaleString('en-IN')} meta={`${plural(v.duplicateLeads, 'existing lead')} · ${plural(v.duplicateStudents, 'enrolled student')}`} />
            <Stat label="Invalid" emphasis value={v.invalid.toLocaleString('en-IN')} meta={v.invalidLine} />
          </div>
          <Card className="gap-3">
            <CardTitle>Duplicates</CardTitle>
            <div className="flex gap-4 flex-wrap" role="radiogroup" aria-label="Duplicate strategy">
              <Radio name="dup" checked={dup === 'merge'} onChange={() => setDup('merge')} label="Merge into existing (update source, add activity)" />
              <Radio name="dup" checked={dup === 'skip'} onChange={() => setDup('skip')} label="Skip" />
              <Radio name="dup" checked={dup === 'create'} onChange={() => setDup('create')} label="Create anyway" />
            </div>
            {dup === 'merge' && v.duplicateStudents > 0 && <div className="text-xs text-neutral-600">Rows matching enrolled students are skipped — students are not leads.</div>}
            <div className="flex gap-2 justify-end flex-wrap">
              <Button variant="ghost" onClick={() => setStep(2)} disabled={preview.length === 0}>
                ← Back to mapping
              </Button>
              <a href={errorsHref} download className={cn(buttonVariants({ variant: 'secondary' }), v.invalid === 0 && 'pointer-events-none opacity-45')} aria-disabled={v.invalid === 0}>
                Download error report
              </a>
              <Button variant="primary" loading={run.isPending} disabled={v.valid + (dup === 'skip' ? 0 : v.duplicates) === 0} onClick={() => run.mutate({ params: { id: job.id }, body: { dupStrategy: dup } })}>
                Run import
              </Button>
            </div>
          </Card>
        </>
      )}

      {step === 4 && job && (
        <Card className="gap-3" aria-live="polite">
          <div className="flex justify-between gap-2 flex-wrap">
            <CardTitle>{job.status === 'completed' ? 'Import complete' : job.status === 'failed' ? 'Import failed' : 'Importing…'}</CardTitle>
            <Tag variant={job.status === 'failed' ? 'ink' : 'accent'}>
              Job {job.shortId}
              {job.durationSec != null ? ` · ${job.durationSec} s` : ''}
            </Tag>
          </div>
          <Bar value={job.status === 'completed' ? 100 : job.progress} height={8} />
          {running && (
            <div className="flex items-center gap-2 text-[13px] text-neutral-700">
              <Spinner /> {job.processedRows.toLocaleString('en-IN')} / {job.totalRows.toLocaleString('en-IN')} rows processed · {job.created.toLocaleString('en-IN')} created · {job.errors} errors found
            </div>
          )}
          {job.status === 'completed' && (
            <div className="flex gap-4 text-[13px] flex-wrap">
              <span>
                <b className="font-semibold">{job.created.toLocaleString('en-IN')}</b> created
              </span>
              <span>
                <b className="font-semibold">{job.merged.toLocaleString('en-IN')}</b> merged
              </span>
              {job.skipped > 0 && (
                <span>
                  <b className="font-semibold">{job.skipped.toLocaleString('en-IN')}</b> skipped
                </span>
              )}
              <span>
                <b className="font-semibold">{job.errors.toLocaleString('en-IN')}</b> errors
              </span>
              {job.created > 0 && <span>· assigned round robin to {plural(job.assignees, 'salesperson', 'salespeople')}</span>}
            </div>
          )}
          {job.status === 'failed' && <Issue kind="blocked">The job stopped — download the error report for details and try again.</Issue>}
          <div className="flex gap-2 justify-end flex-wrap">
            <Button variant="ghost" onClick={reset}>
              Import another file
            </Button>
            <a href={errorsHref} download className={cn(buttonVariants({ variant: 'secondary' }), job.errors === 0 && 'pointer-events-none opacity-45')} aria-disabled={job.errors === 0}>
              Download error report
            </a>
            <Link href="/sales/pipeline" className={buttonVariants({ variant: 'primary' })}>
              Open pipeline
            </Link>
          </div>
          <CardMeta>{job.filename}</CardMeta>
        </Card>
      )}
      {step === 1 && <Kicker className="text-neutral-600">Columns we recognise: Full Name, Mobile, Email ID, Interested In, Campaign, Source, Branch</Kicker>}
    </Page>
  );
}
