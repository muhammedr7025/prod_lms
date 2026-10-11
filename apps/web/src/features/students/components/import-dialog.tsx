'use client';

import { academicsStudentsContract, STUDENT_IMPORT_COLUMNS, STUDENT_IMPORT_REQUIRED, type AcadImportPreview } from '@exatech/contracts';
import { Button, Dialog, Issue, Table, TableScroll, Tag, TD, TH, TR, toast } from '@exatech/ui';
import { useEffect, useRef, useState } from 'react';
import { type ApiError, uploadFile } from '@/lib/api';
import { useApiMutation } from '@/lib/hooks';

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;

/** Go-live import: CSV → preview (validated row by row) → create students, guardians, invited portal users, enrollments. */
export function ImportStudentsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [fileId, setFileId] = useState<string | null>(null);
  const [preview, setPreview] = useState<AcadImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setFile(null);
      setFileId(null);
      setPreview(null);
    }
  }, [open]);
  const validate = useApiMutation(academicsStudentsContract.importPreview, { onSuccess: (d) => setPreview(d) });
  const commit = useApiMutation(academicsStudentsContract.importCommit, {
    invalidate: [['academics'], ['reference']],
    success: (d) => `${d.created} students imported${d.skipped ? ` · ${d.skipped} rows skipped` : ''} · portal invites ready`,
    onSuccess: onClose,
  });

  const choose = async (f: File | null) => {
    setFile(f);
    setPreview(null);
    setFileId(null);
    if (!f) return;
    setBusy(true);
    try {
      const ref = await uploadFile(f, 'import');
      setFileId(ref.id);
      validate.mutate({ body: { fileId: ref.id } });
    } catch (err) {
      toast.error((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const template = () =>
    download(
      'students-import-template.csv',
      [STUDENT_IMPORT_COLUMNS.join(','), 'Asha Nair,9847012345,asha@example.com,2005-03-14,DM-A,2026-08-10,,Ravi Nair,9847098765,,Father'].join('\n'),
    );
  const errorReport = () => preview && download('students-import-errors.csv', ['row,field,message,value', ...preview.errors.map((e) => [e.row, e.field, e.message, e.value].map(esc).join(','))].join('\n'));

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={720}
      kicker="Students · go-live"
      title="Import existing students"
      description="Creates students, guardians, invited portal accounts (student + parent) and enrollments. Fee accounts are set up separately by Finance."
      footerAlign="between"
      footer={
        <>
          <Button variant="ghost" onClick={template}>
            Download CSV template
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!fileId || !preview || preview.valid === 0} loading={commit.isPending} onClick={() => fileId && commit.mutate({ body: { fileId } })}>
              {preview ? `Import ${preview.valid} student${preview.valid === 1 ? '' : 's'}` : 'Import'}
            </Button>
          </div>
        </>
      }
    >
      <button type="button" onClick={() => input.current?.click()} className="p-[18px] border border-dashed border-divider text-center text-[13px] text-neutral-700 bg-transparent cursor-pointer hover:bg-accent-100">
        {file ? `${file.name} · ${(file.size / 1024).toFixed(0)} KB` : `Choose a CSV · columns: ${STUDENT_IMPORT_COLUMNS.join(', ')}`}
      </button>
      <input ref={input} type="file" accept=".csv,text/csv" className="hidden" aria-label="CSV file" onChange={(e) => void choose(e.target.files?.[0] ?? null)} />
      <div className="text-xs text-neutral-600">Required: {STUDENT_IMPORT_REQUIRED.join(', ')}. Dates as YYYY-MM-DD or DD/MM/YYYY. Leave admission_no empty to number automatically.</div>
      {(busy || validate.isPending) && <Issue kind="needed">Validating every row…</Issue>}
      {validate.error && <Issue kind="blocked">{validate.error.message}</Issue>}
      {preview && (
        <>
          <div className="flex gap-2 flex-wrap items-center text-[13px]">
            <Tag variant="accent">{preview.valid} valid</Tag>
            <Tag variant={preview.invalid ? 'ink' : 'neutral'}>{preview.invalid} with errors</Tag>
            <span className="text-neutral-600">{preview.total} rows</span>
            {preview.errors.length > 0 && (
              <Button variant="ghost" size="sm" onClick={errorReport}>
                Download error report
              </Button>
            )}
          </div>
          {preview.missingColumns.length > 0 && <Issue kind="blocked">Missing columns: {preview.missingColumns.join(', ')}</Issue>}
          <TableScroll minWidth={640} className="max-h-[300px] overflow-y-auto border border-divider">
            <Table className="text-[13px]">
              <thead>
                <tr>
                  <TH>Row</TH>
                  <TH>Student</TH>
                  <TH>Phone</TH>
                  <TH>Batch</TH>
                  <TH>Guardian</TH>
                  <TH>Status</TH>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <TR key={r.row}>
                    <TD className="tabular">{r.row}</TD>
                    <TD>{r.name || '—'}</TD>
                    <TD>{r.phone}</TD>
                    <TD>{r.batchCode}</TD>
                    <TD>{r.guardian}</TD>
                    <TD>{r.ok ? <Tag variant="accent">OK</Tag> : <span className="text-xs">{r.errors.join(' · ')}</span>}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        </>
      )}
    </Dialog>
  );
}
