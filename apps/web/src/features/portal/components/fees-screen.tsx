'use client';

import { portalContract, type PortalChild } from '@exatech/contracts';
import { formatINR } from '@exatech/domain';
import { Button, buttonVariants, Card, cn, Issue, Kicker, Skeleton, Tag } from '@exatech/ui';
import { useApi } from '@/lib/hooks';
import { printPdf } from '../lib';
import { LoadError, ScreenHeader } from './parts';
import { usePaySheet } from './pay-sheet';

/** Student / Parent · Fees — instalments, Pay now, invoices & receipts; parents also pay for every child. */
export function FeesScreen({ studentId, label, siblings }: { studentId?: string; label: string; siblings?: PortalChild[] }) {
  const parent = label.startsWith('Parent');
  const enabled = !parent || !!studentId;
  const { data, error, isPending, refetch } = useApi(portalContract.fees, { query: studentId ? { studentId } : {} }, { enabled });
  const pay = usePaySheet();
  const due = data && data.fee.state !== 'cleared' && data.pay;
  const withDues = (siblings ?? []).filter((k) => k.pay);

  return (
    <>
      <ScreenHeader
        label={label}
        kicker={data ? (parent ? `${data.studentName} · ${data.kicker}` : data.kicker) : undefined}
        title="Fees"
        action={
          !parent && data ? (
            <a href={data.statementUrl} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: 'secondary', size: 'lg' }), 'no-underline')}>
              Statement
            </a>
          ) : undefined
        }
      />
      {error && !data && <LoadError what="fees" error={error} onRetry={() => void refetch()} />}
      {(isPending || !enabled) && !data && <Skeleton className="h-[180px]" />}
      {data && (
        <Card pad="none" data-testid="instalments">
          {data.instalments.length === 0 && <div className="px-4 py-6 text-center text-[13px] text-neutral-600">No fee schedule on this enrollment yet.</div>}
          {data.instalments.map((i) => (
            <div key={i.id} className={cn('flex justify-between items-center gap-2.5 p-3 min-h-14 border-b border-divider last:border-b-0', i.highlight && 'bg-accent-100')} data-testid="instalment-row">
              <div className="min-w-0">
                <div className="font-medium">{i.name}</div>
                <div className="text-xs text-neutral-600">{i.sub}</div>
              </div>
              <div className="text-right flex-none">
                <div className="font-semibold tabular">{formatINR(i.amount)}</div>
                <Tag variant={i.tagVariant}>{i.tag}</Tag>
              </div>
            </div>
          ))}
        </Card>
      )}
      {due && data.pay && (
        <Button variant="primary" size="xl" blueprint onClick={() => pay.open(data.pay)} data-testid="pay-now">
          Pay {formatINR(data.pay.nextDue)} now
        </Button>
      )}
      {data && !due && data.pay && (
        <div className="flex justify-between items-center gap-2 text-[13px]">
          <span className="text-neutral-600">{data.fee.sub}</span>
          <Button size="lg" onClick={() => pay.open(data.pay)}>
            Pay ahead
          </Button>
        </div>
      )}
      {parent && data && (
        <>
          <div className="flex gap-1.5">
            <Button size="lg" className="flex-1" disabled={withDues.length === 0} onClick={() => pay.open(withDues.map((k) => k.pay!), { all: true })} data-testid="pay-all">
              Pay for {siblings && siblings.length > 2 ? 'all' : 'both'} children
            </Button>
            <a href={data.statementUrl} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: 'secondary', size: 'lg' }), 'flex-1 no-underline')}>
              Statement of account
            </a>
          </div>
          {withDues.length === 0 ? (
            <Issue kind="ok">Nothing is due for any child right now</Issue>
          ) : (
            <div className="text-xs text-neutral-600">
              {(siblings ?? []).map((k) => (k.pay ? `${k.firstName} ${formatINR(k.dueAmount)}` : `${k.firstName} cleared`)).join(' · ')} · one checkout per child
            </div>
          )}
        </>
      )}
      {data && (
        <Card pad="none" data-testid="documents">
          <Kicker className="px-3 py-2.5 border-b border-divider">Invoices &amp; receipts</Kicker>
          {data.documents.length === 0 && <div className="px-3 py-4 text-[13px] text-neutral-600">No invoices or receipts yet.</div>}
          {data.documents.map((d) => (
            <div key={d.id} className="flex justify-between items-center gap-2 px-3 py-1.5 min-h-12 border-b border-divider last:border-b-0" data-testid="document-row">
              <div className="min-w-0">
                <div className="text-[13px] font-mono truncate">{d.number}</div>
                <div className="text-xs text-neutral-600">{d.sub}</div>
              </div>
              <div className="flex gap-1 flex-none">
                <a href={d.pdfUrl} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: 'ghost', size: 'md' }), 'min-h-11 no-underline')}>
                  PDF
                </a>
                <Button variant="ghost" className="min-h-11" onClick={() => printPdf(d.printUrl)}>
                  Print
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}
      {pay.element}
    </>
  );
}
