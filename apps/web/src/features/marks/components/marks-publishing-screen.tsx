'use client';

import { academicsMarksContract, type AcadExamRow } from '@exatech/contracts';
import { Button, Card, EmptyState, Page, PageHeader, Skeleton, Table, TableScroll, Tag, TD, TH, TR } from '@exatech/ui';
import { useState } from 'react';
import { useDrawer } from '@/components/drawers/drawer-context';
import { useApi } from '@/lib/hooks';
import { PublishButton, ReturnDialog } from './publish-actions';

/** Branch Administrator · Marks publishing — two-step: teacher submits, you publish or return. */
export function MarksPublishingScreen() {
  const { data, isPending, error } = useApi(academicsMarksContract.list, {});
  const drawer = useDrawer();
  const [returning, setReturning] = useState<AcadExamRow | null>(null);
  return (
    <Page label="Branch Admin · Marks publishing">
      <PageHeader kicker="Two-step · teacher submits, you publish" title="Marks publishing" />
      {error && <EmptyState title="Could not load exams" body={error.message} />}
      <Card pad="none">
        <TableScroll minWidth={760}>
          <Table>
            <thead>
              <tr>
                <TH>Exam</TH>
                <TH>Batch</TH>
                <TH>Teacher</TH>
                <TH>Submitted</TH>
                <TH>Students</TH>
                <TH>Average</TH>
                <TH>Status</TH>
                <TH />
              </tr>
            </thead>
            <tbody>
              {isPending &&
                Array.from({ length: 4 }, (_, i) => (
                  <tr key={i}>
                    <TD colSpan={8}>
                      <Skeleton className="h-6" />
                    </TD>
                  </tr>
                ))}
              {data?.items.map((e) => (
                <TR key={e.id} data-testid="exam-row">
                  <TD className="font-medium">{e.name}</TD>
                  <TD>{e.batchCode}</TD>
                  <TD>{e.teacherName}</TD>
                  <TD className="text-neutral-600">{e.submittedLabel}</TD>
                  <TD className="tabular">{e.students}</TD>
                  <TD className="tabular">{e.average}</TD>
                  <TD>
                    <Tag variant={e.tag}>{e.statusLabel}</Tag>
                  </TD>
                  <TD className="text-right whitespace-nowrap">
                    {e.status === 'submitted' && data.canPublish && (
                      <div className="flex gap-1.5 justify-end">
                        <Button variant="ghost" size="sm" onClick={() => setReturning(e)}>
                          Return
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => drawer.open('exam', e.id)}>
                          Review grid
                        </Button>
                        <PublishButton exam={e} size="sm" />
                      </div>
                    )}
                    {e.status === 'published' && (
                      <span className="inline-flex items-center gap-1.5">
                        <Button variant="ghost" size="sm" onClick={() => drawer.open('exam', e.id)}>
                          View grid
                        </Button>
                        <span className="text-xs text-neutral-600">Visible to students &amp; parents</span>
                      </span>
                    )}
                    {(e.status === 'draft' || e.status === 'returned') && <span className="text-xs text-neutral-600">Teacher still entering</span>}
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableScroll>
        {data && data.items.length === 0 && <EmptyState title="No exams yet" body="Exams appear here when teachers create them; submitted marks wait for you to publish or return." />}
      </Card>
      <ReturnDialog exam={returning} onClose={() => setReturning(null)} />
    </Page>
  );
}
