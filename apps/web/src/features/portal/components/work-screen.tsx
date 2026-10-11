'use client';

import { portalContract, type WorkItem } from '@exatech/contracts';
import { Button, Card, CardTitle, Field, Icon, Issue, Kicker, LinkButton, Skeleton, Tag, Textarea } from '@exatech/ui';
import { useRef, useState } from 'react';
import { useMe } from '@/components/me-context';
import { ApiError, uploadFile } from '@/lib/api';
import { useApi, useApiMutation } from '@/lib/hooks';
import { LoadError, ScreenHeader } from './parts';

/** Student · Work — assignments with status, attach a file and/or write an answer, submit (late policy applies). */
export function WorkScreen() {
  const { data, error, isPending, refetch } = useApi(portalContract.work, {});
  return (
    <>
      <ScreenHeader label="Student · Work" kicker={data?.kicker} title="Work" />
      {error && !data && <LoadError what="assignments" error={error} onRetry={() => void refetch()} />}
      {isPending && !data && Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-[132px]" />)}
      {data && data.items.length === 0 && (
        <Card pad="none">
          <div className="px-4 py-6 text-center text-[13px] text-neutral-600">No assignments yet — your teacher&apos;s assignments appear here.</div>
        </Card>
      )}
      {data?.items.map((w) => <WorkCard key={w.id} w={w} />)}
      {data && <div className="text-xs text-neutral-600 text-center">{data.footer}</div>}
    </>
  );
}

function WorkCard({ w }: { w: WorkItem }) {
  const me = useMe();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<{ id: string; filename: string; size: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const submit = useApiMutation(portalContract.submitWork, {
    invalidate: [['portal']],
    success: (r) => (r.status === 'submitted' ? `${r.title} · submitted · awaiting grade` : 'Submitted'),
    toastError: false,
    onSuccess: () => {
      setFile(null);
      setText('');
      setWriting(false);
      setErr(null);
    },
    onError: (e) => setErr(e.message),
  });

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr(null);
    setUploading(true);
    try {
      const ref = await uploadFile(f, 'submission');
      setFile({ id: ref.id, filename: ref.filename, size: ref.size });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Upload failed — try again');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const ready = !!file || !!text.trim();
  const resubmit = !!w.submission;
  return (
    <Card className="p-3.5 gap-2" data-testid="work-card" data-status={w.status}>
      <div className="flex justify-between gap-2 items-start">
        <Kicker>{w.batchCode}</Kicker>
        <Tag variant={w.tagVariant} className="flex-none" data-testid="work-status">
          {w.statusLabel}
        </Tag>
      </div>
      <CardTitle>{w.title}</CardTitle>
      <div className="text-xs text-neutral-600">{w.dueLabel}</div>
      {w.instructions && <div className="text-[13px] text-neutral-700">{w.instructions}</div>}
      {w.submission && (
        <div className="text-[13px] border-t border-divider pt-2 grid gap-0.5">
          <div className="text-neutral-700">{w.submission.line}</div>
          {w.submission.fileName && (
            <div className="flex items-center gap-1.5 text-xs">
              <Icon name="file" size={13} /> {w.submission.fileName}
            </div>
          )}
          {w.submission.text && <div className="text-xs text-neutral-600 whitespace-pre-line line-clamp-3">{w.submission.text}</div>}
          {w.submission.feedback && (
            <div className="mt-1 bg-accent-100 px-2.5 py-1.5 text-[13px]">
              <span className="text-[10px] tracking-[0.1em] uppercase text-accent-800">Feedback · </span>
              {w.submission.feedback}
            </div>
          )}
        </div>
      )}
      {w.canSubmit && !me.readOnly && (
        <>
          {file && (
            <div className="flex items-center gap-2 text-[13px] border border-divider px-2.5 py-1.5" data-testid="work-attachment">
              <Icon name="file" size={14} />
              <span className="flex-1 min-w-0 truncate">{file.filename}</span>
              <span className="text-xs text-neutral-600 tabular">{Math.max(1, Math.round(file.size / 1024))} KB</span>
              <LinkButton className="min-h-11 px-1" onClick={() => setFile(null)}>
                Remove
              </LinkButton>
            </div>
          )}
          {writing && (
            <Field label="Your answer or a link">
              <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} placeholder="Write your answer, or paste a link to your work" />
            </Field>
          )}
          <input ref={fileInput} type="file" className="sr-only" aria-label={`Attach a file to ${w.title}`} accept=".pdf,.zip,.png,.jpg,.jpeg,.docx,.xlsx,.pptx,.txt" onChange={(e) => void pick(e.target.files?.[0])} data-testid="work-file" />
          <div className="flex gap-1.5">
            <Button size="lg" className="flex-1" loading={uploading} onClick={() => fileInput.current?.click()}>
              {file ? 'Replace file' : 'Attach file'}
            </Button>
            <Button variant="primary" size="lg" className="flex-1" disabled={!ready || uploading} loading={submit.isPending} onClick={() => submit.mutate({ params: { id: w.id }, body: { fileId: file?.id, text: text.trim() || undefined } })}>
              {resubmit ? 'Resubmit' : 'Submit'}
            </Button>
          </div>
          <div className="flex justify-between items-center gap-2 text-xs text-neutral-600">
            <span>{ready ? (w.status === 'late' ? 'Late — the penalty applies when graded' : resubmit ? 'Replaces your earlier submission until it is graded' : 'Ready to submit') : 'Attach a file or write your answer to submit'}</span>
            {!writing && (
              <LinkButton className="min-h-11 flex-none" onClick={() => setWriting(true)}>
                Write an answer
              </LinkButton>
            )}
          </div>
        </>
      )}
      {w.blockedReason && <Issue kind="blocked">{w.blockedReason}</Issue>}
      {w.canSubmit && me.readOnly && <div className="text-xs text-neutral-600">Read-only view — submitting is disabled.</div>}
      {err && <Issue kind="blocked">{err}</Issue>}
    </Card>
  );
}
