'use client';

import { academicsMarksContract } from '@exatech/contracts';
import { Button, Dialog, Field, Textarea } from '@exatech/ui';
import { useEffect, useState } from 'react';
import { useApiMutation } from '@/lib/hooks';

interface ExamRef {
  id: string;
  name: string;
  batchCode: string;
  teacherName: string;
}

export function PublishButton({ exam, size = 'md', label = 'Publish', onDone }: { exam: ExamRef; size?: 'sm' | 'md'; label?: string; onDone?: () => void }) {
  const publish = useApiMutation(academicsMarksContract.publish, {
    invalidate: [['academics']],
    success: `${exam.name} published · students & parents notified`,
    onSuccess: () => onDone?.(),
  });
  return (
    <Button variant="primary" size={size} loading={publish.isPending} onClick={() => publish.mutate({ params: { id: exam.id } })}>
      {label}
    </Button>
  );
}

/** Return submitted marks to the teacher with a note (status → returned). */
export function ReturnDialog({ exam, onClose }: { exam: ExamRef | null; onClose: () => void }) {
  const [note, setNote] = useState('');
  useEffect(() => setNote(''), [exam]);
  const ret = useApiMutation(academicsMarksContract.returnExam, { invalidate: [['academics']], success: 'Returned to the teacher with your note', onSuccess: onClose });
  return (
    <Dialog
      open={!!exam}
      onOpenChange={(o) => !o && onClose()}
      kicker={exam ? `${exam.batchCode} · ${exam.teacherName}` : 'Marks'}
      title={exam ? `Return · ${exam.name}` : 'Return marks'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={note.trim().length < 3} loading={ret.isPending} onClick={() => exam && ret.mutate({ params: { id: exam.id }, body: { note: note.trim() } })}>
            Return to teacher
          </Button>
        </>
      }
    >
      <Field label="Note for the teacher (required)">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Practical marks for row 7 look swapped — please recheck" autoFocus />
      </Field>
    </Dialog>
  );
}
