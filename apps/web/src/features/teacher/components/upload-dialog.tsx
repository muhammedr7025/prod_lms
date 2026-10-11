'use client';

import { teachingMaterialsContract, TEACH_MATERIAL_TYPES, TEACH_VISIBILITIES, type FileRef, type TeachBatch } from '@exatech/contracts';
import { Bar, Button, Card, cn, Dialog, Field, Input, Select } from '@exatech/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { useApiMutation } from '@/lib/hooks';
import { addDaysClient, NeededList, todayISTClient } from './parts';

type MaterialType = (typeof TEACH_MATERIAL_TYPES)[number];
type Visibility = (typeof TEACH_VISIBILITIES)[number];

const VIS_LABEL: Record<Visibility, string> = { always: 'Always visible', fee_gated: 'Fee-gated', scheduled: 'Scheduled' };

function typeFor(name: string): MaterialType | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'pdf') return 'PDF';
  if (ext === 'pptx') return 'Slides';
  if (ext === 'xlsx') return 'XLSX';
  if (ext === 'zip') return 'ZIP';
  if (ext === 'mp4') return 'Video';
  return null;
}

/** Multipart upload with progress (XHR — fetch has no upload progress). */
function uploadWithProgress(file: File, onProgress: (pct: number) => void): Promise<FileRef> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files?purpose=material');
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText) as FileRef);
        return;
      }
      let msg = 'Upload failed';
      try {
        msg = (JSON.parse(xhr.responseText) as { error?: { message?: string } }).error?.message ?? msg;
      } catch {
        /* non-JSON */
      }
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error('Upload failed — check your connection'));
    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  });
}

/** Upload material: file (or link for video / link types), batch, type, module, title, visibility, release date. */
export function UploadDialog({ open, onOpenChange, batches, batchId: initialBatch, modules }: { open: boolean; onOpenChange: (o: boolean) => void; batches: TeachBatch[]; batchId: string | null; modules: string[] }) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [batchId, setBatchId] = useState('');
  const [type, setType] = useState<MaterialType>('PDF');
  const [moduleName, setModuleName] = useState('');
  const [title, setTitle] = useState('');
  const [vis, setVis] = useState<Visibility>('fee_gated');
  const [releaseOn, setReleaseOn] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<{ name: string; pct: number; ref: FileRef | null; error: string | null } | null>(null);
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBatchId(initialBatch ?? batches[0]?.id ?? '');
    setType('PDF');
    setModuleName('');
    setTitle('');
    setVis('fee_gated');
    setReleaseOn(addDaysClient(todayISTClient(), 7));
    setUrl('');
    setFile(null);
  }, [open, initialBatch, batches]);

  const upload = useApiMutation(teachingMaterialsContract.upload, {
    invalidate: [['teaching']],
    success: 'Uploaded · students notified',
    onSuccess: () => onOpenChange(false),
  });

  const linkType = type === 'Video' || type === 'Link';
  const pickFile = (f: File | undefined) => {
    if (!f) return;
    const t = typeFor(f.name);
    if (t) setType(t);
    if (!title.trim()) setTitle(f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '));
    setFile({ name: f.name, pct: 0, ref: null, error: null });
    uploadWithProgress(f, (pct) => setFile((x) => (x ? { ...x, pct } : x)))
      .then((ref) => setFile((x) => (x ? { ...x, pct: 100, ref } : x)))
      .catch((err: Error) => setFile((x) => (x ? { ...x, error: err.message } : x)));
  };

  const validUrl = /^https?:\/\/\S+\.\S+/.test(url.trim());
  const issues = [
    ...(!batchId ? ['Batch'] : []),
    ...(linkType && type === 'Link' && !validUrl ? ['Paste the link (https://…)'] : []),
    ...(linkType && type === 'Video' && !validUrl && !file?.ref ? ['Paste the video link (or drop an MP4)'] : []),
    ...(!linkType && !file ? ['Choose the file'] : []),
    ...(!linkType && file && !file.ref && !file.error ? ['Wait for the upload to finish'] : []),
    ...(file?.error ? [file.error] : []),
    ...(!moduleName.trim() ? ['Module / topic'] : []),
    ...(title.trim().length < 2 ? ['Title'] : []),
    ...(vis === 'scheduled' && (!releaseOn || releaseOn < todayISTClient()) ? ['Release date (today or later)'] : []),
  ];

  const save = () =>
    upload.mutate({
      body: {
        batchId,
        type,
        module: moduleName.trim(),
        title: title.trim(),
        visibility: vis,
        releaseOn: vis === 'scheduled' ? releaseOn : null,
        fileId: !linkType || (type === 'Video' && !validUrl) ? (file?.ref?.id ?? null) : null,
        url: linkType && validUrl ? url.trim() : null,
      },
    });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      kicker="Notes & material"
      title="Upload material"
      width={520}
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" disabled={issues.length > 0} loading={upload.isPending} onClick={save}>
            Upload
          </Button>
        </>
      }
    >
      {linkType ? (
        <Field label={type === 'Video' ? 'Video link' : 'Link'}>
          <Input className="min-h-11" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" inputMode="url" />
        </Field>
      ) : (
        <Card
          tone="dashed"
          className={cn('p-[18px] text-center text-[13px] text-neutral-700 cursor-pointer gap-1.5', drag && 'bg-accent-100 border-accent')}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            pickFile(e.dataTransfer.files[0]);
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
          }}
          data-testid="material-dropzone"
        >
          <input
            ref={inputRef}
            type="file"
            className="sr-only"
            accept=".pdf,.pptx,.xlsx,.zip,.mp4"
            onChange={(e) => pickFile(e.target.files?.[0])}
            data-testid="material-file"
            aria-label="Choose a file"
          />
          {file ? (
            <>
              <div className="font-medium text-ink truncate">{file.name}</div>
              <Bar value={file.pct} height={4} />
              <div className="text-xs">{file.error ? file.error : file.ref ? 'Uploaded · tap to replace' : `Uploading · ${file.pct}%`}</div>
            </>
          ) : (
            'Drop a file or tap to choose · PDF, PPTX, XLSX, ZIP, video link · up to 200 MB'
          )}
        </Card>
      )}
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Batch">
          <Select className="min-h-11" value={batchId} onChange={(e) => setBatchId(e.target.value)} options={batches.map((b) => ({ value: b.id, label: b.code }))} />
        </Field>
        <Field label="Type">
          <Select className="min-h-11" value={type} onChange={(e) => setType(e.target.value as MaterialType)} options={[...TEACH_MATERIAL_TYPES]} />
        </Field>
        <Field label="Module / topic" className="col-span-2">
          <Input className="min-h-11" value={moduleName} onChange={(e) => setModuleName(e.target.value)} placeholder="Module 3 · Paid media" list={listId} maxLength={120} />
        </Field>
        <datalist id={listId}>
          {modules.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <Field label="Title" className="col-span-2">
          <Input className="min-h-11" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Campaign structure worksheet" maxLength={160} />
        </Field>
        <Field label="Visibility">
          <Select className="min-h-11" value={vis} onChange={(e) => setVis(e.target.value as Visibility)} options={TEACH_VISIBILITIES.map((v) => ({ value: v, label: VIS_LABEL[v] }))} />
        </Field>
        {vis === 'scheduled' && (
          <Field label="Release on">
            <Input type="date" className="min-h-11" value={releaseOn} min={todayISTClient()} onChange={(e) => setReleaseOn(e.target.value)} />
          </Field>
        )}
      </div>
      <NeededList items={issues} />
    </Dialog>
  );
}
