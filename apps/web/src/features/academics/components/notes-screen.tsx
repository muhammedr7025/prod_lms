'use client';

import { academicsMaterialsContract, ACAD_MATERIAL_TYPES, type AcadMaterialRow } from '@exatech/contracts';
import { addDays, todayIST } from '@exatech/domain';
import { Button, Card, Dialog, EmptyState, Field, Grid, Input, Issue, Page, PageHeader, Radio, Row, Select, Skeleton, Stat, Table, TableScroll, Tag, TD, TH, TR, toast } from '@exatech/ui';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { callApi, type ApiError, uploadFile } from '@/lib/api';
import { useApi, useApiMutation } from '@/lib/hooks';

type Vis = 'always' | 'fee_gated' | 'scheduled';
const VIS_OPTIONS: { value: Vis; label: string }[] = [
  { value: 'always', label: 'Always visible' },
  { value: 'fee_gated', label: 'Fee-gated' },
  { value: 'scheduled', label: 'Scheduled' },
];

/** Notes & material oversight (Branch Administrator). */
export function NotesScreen() {
  const { data, isPending, error } = useApi(academicsMaterialsContract.list, {});
  const [uploadOpen, setUploadOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [changing, setChanging] = useState<AcadMaterialRow | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);

  const preview = async (m: AcadMaterialRow) => {
    setPreviewing(m.id);
    try {
      const r = await callApi(academicsMaterialsContract.preview, { params: { id: m.id } });
      window.open(r.url, '_blank', 'noopener');
    } catch (err) {
      toast.error((err as ApiError).message);
    } finally {
      setPreviewing(null);
    }
  };

  return (
    <Page label="Notes & material">
      <PageHeader
        kicker={`${data?.branchLabel ?? '…'} · visibility: always · fee-gated · scheduled`}
        title="Notes & material"
        actions={
          <>
            <Button variant="secondary" onClick={() => setRulesOpen(true)}>
              Visibility rules
            </Button>
            {data?.canUpload && (
              <Button variant="primary" onClick={() => setUploadOpen(true)}>
                Upload for a batch
              </Button>
            )}
          </>
        }
      />
      {error && <EmptyState title="Could not load material" body={error.message} />}
      <Grid min={170}>
        {!data ? (
          Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[92px]" />)
        ) : (
          <>
            <Stat label="Items" value={data.kpis.items} meta="across running batches" />
            <Stat label="Fee-gated" value={data.kpis.feeGated} meta="unlock on payment webhook" />
            <Stat
              label="Students locked out"
              value={data.kpis.lockedOut}
              emphasis
              meta={
                <span>
                  fees not cleared ·{' '}
                  <Link href="/finance/dues" className="underline underline-offset-[3px] text-ink">
                    see Dues
                  </Link>
                </span>
              }
            />
            <Stat label="Downloads today" value={data.kpis.downloadsToday} meta="5-min signed URLs · watermarked" />
          </>
        )}
      </Grid>
      <Card pad="none">
        <TableScroll minWidth={820}>
          <Table>
            <thead>
              <tr>
                <TH>Batch</TH>
                <TH>Module</TH>
                <TH>Title</TH>
                <TH>Type</TH>
                <TH>Visibility</TH>
                <TH>Uploaded by</TH>
                <TH>Opened</TH>
                <TH />
              </tr>
            </thead>
            <tbody>
              {isPending &&
                Array.from({ length: 8 }, (_, i) => (
                  <tr key={i}>
                    <TD colSpan={8}>
                      <Skeleton className="h-6" />
                    </TD>
                  </tr>
                ))}
              {data?.items.map((m) => (
                <TR key={m.id} data-testid="material-row">
                  <TD className="font-medium">{m.batchCode}</TD>
                  <TD className="text-neutral-700">{m.module}</TD>
                  <TD>{m.title}</TD>
                  <TD>
                    <Tag variant="neutral">{m.type}</Tag>
                  </TD>
                  <TD>
                    <Tag variant={m.visibilityTag}>{m.visibilityLabel}</Tag>
                  </TD>
                  <TD>{m.uploadedBy}</TD>
                  <TD className="tabular">{m.opened}</TD>
                  <TD className="text-right whitespace-nowrap">
                    <Button variant="ghost" size="sm" disabled={!m.previewable} loading={previewing === m.id} onClick={() => preview(m)}>
                      Preview
                    </Button>
                    {data.canUpload && (
                      <Button variant="ghost" size="sm" onClick={() => setChanging(m)}>
                        Change visibility
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableScroll>
        {data && data.items.length === 0 && <EmptyState title="No material yet" body="Teachers upload notes by syllabus module; you can also upload for a batch here." />}
      </Card>

      {data && <UploadMaterialDialog open={uploadOpen} onClose={() => setUploadOpen(false)} batches={data.batches} />}
      <VisibilityDialog material={changing} onClose={() => setChanging(null)} />
      <Dialog open={rulesOpen} onOpenChange={setRulesOpen} kicker="Notes & material" title="Visibility rules" width={520} footer={<Button onClick={() => setRulesOpen(false)}>Close</Button>}>
        <div className="text-[13px] grid gap-2">
          <p className="m-0">
            <b className="font-medium">Always visible</b> — every enrolled student can open it. <b className="font-medium">Fee-gated</b> — opens only while the student&apos;s fees are cleared under the course policy; it unlocks automatically
            when a payment clears. <b className="font-medium">Scheduled</b> — released on a date (08:00 IST), then follows fee clearance.
          </p>
          <p className="m-0 text-neutral-700">Downloads use 5-minute signed links and PDFs are watermarked with the student&apos;s name.</p>
        </div>
        <div>
          <Row>
            <span className="text-neutral-600">Institution default</span>
            <span>{data?.rules.defaultPolicy ?? '…'}</span>
          </Row>
          {data?.rules.courses.map((c, i) => (
            <Row key={c.code} last={i === data.rules.courses.length - 1}>
              <span className="text-neutral-600">
                {c.code} · {c.name}
              </span>
              <span className="text-right">{c.policy}</span>
            </Row>
          ))}
        </div>
      </Dialog>
    </Page>
  );
}

function VisibilityDialog({ material, onClose }: { material: AcadMaterialRow | null; onClose: () => void }) {
  const [vis, setVis] = useState<Vis>('always');
  const [date, setDate] = useState(addDays(todayIST(), 7));
  useEffect(() => {
    if (material) {
      // Suggest the next state in the cycle always → fee-gated → scheduled → always.
      setVis(material.visibility === 'always' ? 'fee_gated' : material.visibility === 'fee_gated' ? 'scheduled' : 'always');
      setDate(material.releaseOn ?? addDays(todayIST(), 7));
    }
  }, [material]);
  const change = useApiMutation(academicsMaterialsContract.visibility, { invalidate: [['academics', 'materials']], success: 'Visibility changed · students see it on their next refresh', onSuccess: onClose });
  if (!material) return <Dialog open={false} onOpenChange={onClose} title="Change visibility" />;
  const pastDate = vis === 'scheduled' && date < todayIST();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      kicker={`${material.batchCode} · ${material.module}`}
      title={`Change visibility · ${material.title}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={pastDate || (vis === material.visibility && (vis !== 'scheduled' || date === material.releaseOn))} loading={change.isPending} onClick={() => change.mutate({ params: { id: material.id }, body: { visibility: vis, releaseOn: vis === 'scheduled' ? date : null } })}>
            Save visibility
          </Button>
        </>
      }
    >
      <div className="grid gap-2">
        {VIS_OPTIONS.map((o) => (
          <Radio key={o.value} name="vis" checked={vis === o.value} onChange={() => setVis(o.value)} label={o.label} />
        ))}
      </div>
      {vis === 'scheduled' && (
        <Field label="Release on" error={pastDate ? 'The release date is in the past' : null}>
          <Input type="date" value={date} min={todayIST()} onChange={(e) => setDate(e.target.value)} />
        </Field>
      )}
      <div className="text-xs text-neutral-600">Currently: {material.visibilityLabel}</div>
    </Dialog>
  );
}

export function UploadMaterialDialog({ open, onClose, batches }: { open: boolean; onClose: () => void; batches: { id: string; code: string }[] }) {
  const [batchId, setBatchId] = useState('');
  const [type, setType] = useState<(typeof ACAD_MATERIAL_TYPES)[number]>('PDF');
  const [module, setModule] = useState('');
  const [title, setTitle] = useState('');
  const [vis, setVis] = useState<Vis>('always');
  const [date, setDate] = useState(addDays(todayIST(), 7));
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setBatchId(batches[0]?.id ?? '');
      setType('PDF');
      setModule('');
      setTitle('');
      setVis('always');
      setUrl('');
      setFile(null);
    }
  }, [open, batches]);
  const upload = useApiMutation(academicsMaterialsContract.upload, { invalidate: [['academics', 'materials']], success: 'Uploaded · students notified', onSuccess: onClose, toastError: true });
  const linkType = type === 'Link' || type === 'Video';
  const issues: string[] = [];
  if (!batchId) issues.push('Choose a batch');
  if (module.trim().length < 2) issues.push('Module / topic');
  if (title.trim().length < 3) issues.push('Title');
  if (type === 'Link' && !/^https?:\/\/\S+$/.test(url.trim())) issues.push('A valid link (https://…)');
  if (type === 'Video' && !file && !/^https?:\/\/\S+$/.test(url.trim())) issues.push('A video file or link');
  if (!linkType && !file) issues.push('Choose the file');
  if (vis === 'scheduled' && date < todayIST()) issues.push('A release date from today');
  const save = async () => {
    setBusy(true);
    try {
      const ref = file ? await uploadFile(file, 'material') : null;
      upload.mutate({
        body: { batchId, type, module: module.trim(), title: title.trim(), visibility: vis, releaseOn: vis === 'scheduled' ? date : null, fileId: ref?.id ?? null, url: ref ? null : url.trim() || null },
      });
    } catch (err) {
      toast.error((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={520}
      kicker="Notes & material"
      title="Upload material"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={issues.length > 0} loading={busy || upload.isPending} onClick={save}>
            Upload
          </Button>
        </>
      }
    >
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f) setFile(f);
        }}
        className="relative p-[18px] border border-dashed border-divider text-center text-[13px] text-neutral-700 bg-transparent cursor-pointer hover:bg-accent-100"
      >
        {file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : 'Drop a file or tap to choose · PDF, PPTX, XLSX, ZIP, video link · up to 200 MB'}
      </button>
      <input ref={input} type="file" className="hidden" aria-label="Material file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Batch">
          <Select value={batchId} onChange={(e) => setBatchId(e.target.value)} options={batches.map((b) => ({ value: b.id, label: b.code }))} />
        </Field>
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value as typeof type)} options={[...ACAD_MATERIAL_TYPES]} />
        </Field>
        <Field label="Module / topic" className="col-span-2">
          <Input value={module} onChange={(e) => setModule(e.target.value)} placeholder="Module 3 · Paid media" />
        </Field>
        <Field label="Title" className="col-span-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Campaign structure worksheet" />
        </Field>
        {linkType && (
          <Field label={type === 'Video' ? 'Video link (or attach the file above)' : 'Link'} className="col-span-2">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          </Field>
        )}
        <Field label="Visibility">
          <Select value={vis} onChange={(e) => setVis(e.target.value as Vis)} options={VIS_OPTIONS} />
        </Field>
        {vis === 'scheduled' && (
          <Field label="Release on">
            <Input type="date" value={date} min={todayIST()} onChange={(e) => setDate(e.target.value)} />
          </Field>
        )}
      </div>
      <div className="grid gap-1">
        {issues.map((i) => (
          <Issue key={i} kind="needed">
            {i}
          </Issue>
        ))}
      </div>
    </Dialog>
  );
}
