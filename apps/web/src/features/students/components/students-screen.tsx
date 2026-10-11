'use client';

import { academicsStudentsContract, type AcadFeeStatus, type AcadStudentRow } from '@exatech/contracts';
import { Bar, Button, Card, Dialog, EmptyState, Field, Input, LinkButton, Mono, Page, PageHeader, Select, Skeleton, Table, TableScroll, Tag, TD, TH, TR } from '@exatech/ui';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDrawer } from '@/components/drawers/drawer-context';
import { useCan } from '@/components/me-context';
import { callApi, keyFor, type ApiResult } from '@/lib/api';
import { ImportStudentsDialog } from './import-dialog';

const DEFAULT_QUERY = { limit: 50 } as const;

/** Branch Administrator · Students — searchable directory (name / phone / admission no. / barcode / QR card). */
export function StudentsScreen() {
  const drawer = useDrawer();
  const canManage = useCan('academics:students.manage');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [batchId, setBatchId] = useState('');
  const [fee, setFee] = useState<'' | AcadFeeStatus>('');
  const [low, setLow] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const openOnResult = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const query = useMemo(() => ({ ...DEFAULT_QUERY, ...(q ? { q } : {}), ...(batchId ? { batchId } : {}), ...(fee ? { fee } : {}), ...(low ? { lowAttendance: 'true' as const } : {}) }), [q, batchId, fee, low]);
  const qc = useQueryClient();
  const isDefault = !q && !batchId && !fee && !low;
  const seed = isDefault ? qc.getQueryData<ApiResult<typeof academicsStudentsContract.list>>(keyFor(academicsStudentsContract.list, { query: DEFAULT_QUERY })) : undefined;
  const list = useInfiniteQuery({
    initialData: seed ? { pages: [seed], pageParams: [''] } : undefined,
    queryKey: [...keyFor(academicsStudentsContract.list, { query }), 'infinite'],
    queryFn: ({ pageParam }) => callApi(academicsStudentsContract.list, { query: { ...query, ...(pageParam ? { cursor: pageParam } : {}) } }),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: (prev) => prev,
  });
  const first = list.data?.pages[0];
  const rows: AcadStudentRow[] = list.data?.pages.flatMap((p) => p.items) ?? [];

  // A barcode scanner types the admission number and presses Enter: open the match directly.
  useEffect(() => {
    if (openOnResult.current && !list.isFetching && q && rows.length === 1) {
      openOnResult.current = false;
      drawer.open('student', rows[0]!.id);
    }
  }, [rows, list.isFetching, q, drawer]);

  return (
    <Page label="Branch Admin · Students">
      <PageHeader
        kicker={first ? `${first.branchLabel} · ${first.activeTotal} active` : <Skeleton className="h-3 w-40" />}
        title="Students"
        actions={
          canManage && (
            <>
              <Button variant="secondary" onClick={() => setImportOpen(true)}>
                Import for go-live
              </Button>
              <Button variant="primary" onClick={() => setPrintOpen(true)}>
                Print ID cards
              </Button>
            </>
          )
        }
      />
      <div className="flex gap-2 flex-wrap">
        <Input
          placeholder="Name, phone or admission number · scan barcode"
          aria-label="Search students"
          className="max-w-[320px]"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setQ(search.trim());
              openOnResult.current = true;
            }
          }}
        />
        <Select className="w-auto" aria-label="Batch" value={batchId} onChange={(e) => setBatchId(e.target.value)} options={[{ value: '', label: 'All batches' }, ...(first?.batches ?? []).map((b) => ({ value: b.id, label: b.code }))]} />
        <Select
          className="w-auto"
          aria-label="Fee status"
          value={fee}
          onChange={(e) => setFee(e.target.value as typeof fee)}
          options={[
            { value: '', label: 'Fee status' },
            { value: 'cleared', label: 'Cleared' },
            { value: 'partial', label: 'Partially paid' },
            { value: 'overdue', label: 'Overdue' },
          ]}
        />
        <Select
          className="w-auto"
          aria-label="Attendance"
          value={low ? 'low' : ''}
          onChange={(e) => setLow(e.target.value === 'low')}
          options={[
            { value: '', label: 'Attendance' },
            { value: 'low', label: 'Below 75%' },
          ]}
        />
      </div>
      <Card pad="none">
        <TableScroll minWidth={860}>
          <Table>
            <thead>
              <tr>
                <TH>Admission no.</TH>
                <TH>Student</TH>
                <TH>Batch</TH>
                <TH>Guardian</TH>
                <TH>Attendance</TH>
                <TH>Fee status</TH>
                <TH>Enrollment</TH>
                <TH />
              </tr>
            </thead>
            <tbody>
              {list.isPending &&
                Array.from({ length: 8 }, (_, i) => (
                  <tr key={i}>
                    <TD colSpan={8}>
                      <Skeleton className="h-6" />
                    </TD>
                  </tr>
                ))}
              {rows.map((st) => (
                <TR key={st.id} data-testid="student-row">
                  <TD>
                    <Mono>{st.admissionNo ?? '—'}</Mono>
                  </TD>
                  <TD>
                    <LinkButton className="font-medium" onClick={() => drawer.open('student', st.id)}>
                      {st.name}
                    </LinkButton>
                  </TD>
                  <TD>{st.batchCode ?? '—'}</TD>
                  <TD className="text-neutral-700">{st.guardian}</TD>
                  <TD>
                    <div className="flex items-center gap-2">
                      <Bar value={st.attendancePct} className="w-[60px]" height={5} tone={st.attendancePct < 75 ? 'ink' : 'accent'} />
                      <span className="tabular">{st.attendancePct}%</span>
                    </div>
                  </TD>
                  <TD>
                    <Tag variant={st.feeTag}>{st.feeLabel}</Tag>
                  </TD>
                  <TD>
                    <Tag variant="neutral">{st.enrollmentLabel}</Tag>
                  </TD>
                  <TD className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => drawer.open('student', st.id)}>
                      Profile
                    </Button>
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableScroll>
        {!list.isPending && rows.length === 0 && <EmptyState title="No students match" body="Search by name, phone or admission number — scanning an ID card barcode or QR works too." />}
        {list.error && <EmptyState title="Could not load students" body={list.error.message} />}
        <div className="flex justify-between items-center gap-3 flex-wrap px-4 py-2.5 text-xs text-neutral-600 border-t border-divider">
          <span>
            Showing {rows.length} of {first?.total ?? '…'} · keyset pagination · new admissions appear here on approval
          </span>
          <span className="flex items-center gap-3">
            {list.hasNextPage && (
              <Button variant="secondary" size="sm" loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
                Load more
              </Button>
            )}
            PII masked in lists · exports watermarked
          </span>
        </div>
      </Card>
      {canManage && <ImportStudentsDialog open={importOpen} onClose={() => setImportOpen(false)} />}
      <PrintCardsDialog open={printOpen} onClose={() => setPrintOpen(false)} batches={first?.batches ?? []} defaultBatch={batchId} />
    </Page>
  );
}

function PrintCardsDialog({ open, onClose, batches, defaultBatch }: { open: boolean; onClose: () => void; batches: { id: string; code: string }[]; defaultBatch: string }) {
  const [batch, setBatch] = useState('');
  useEffect(() => {
    if (open) setBatch(defaultBatch || batches[0]?.id || '');
  }, [open, defaultBatch, batches]);
  const href = batch ? `${academicsStudentsContract.idCardSheetPath}?batchId=${batch}` : undefined;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      kicker="Students"
      title="Print ID cards"
      description="One A4 sheet per batch: name, admission number, batch, course, validity, Code 128 barcode and a signed QR. Single cards print from the student panel."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <a href={href} target="_blank" rel="noopener" aria-disabled={!href} onClick={() => href && onClose()}>
            <Button variant="primary" disabled={!href}>
              Open PDF
            </Button>
          </a>
        </>
      }
    >
      <Field label="Batch">
        <Select value={batch} onChange={(e) => setBatch(e.target.value)} options={batches.map((b) => ({ value: b.id, label: b.code }))} />
      </Field>
    </Dialog>
  );
}
