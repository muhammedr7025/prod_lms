import { financeContract } from '@exatech/contracts';
import { formatDate, formatINR } from '@exatech/domain';
import { Card, CardTitle, Kicker, Row, Tag } from '@exatech/ui';
import { ApiError, type ApiResult } from '@/lib/api';
import { serverApi } from '@/lib/server';

export const metadata = { title: 'Verify document' };
export const dynamic = 'force-dynamic';

/** Public verification behind the QR on receipts, invoices and credit notes (no sign-in). */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let doc: ApiResult<typeof financeContract.verify> | null = null;
  let error: string | null = null;
  try {
    doc = await serverApi(financeContract.verify, { params: { token } });
  } catch (e) {
    error = e instanceof ApiError && e.status === 404 ? 'This code does not match any Exatech document. The document may be forged — contact the branch accounts office.' : 'Verification is unavailable right now. Please try again shortly.';
  }
  const good = doc?.status === 'valid' || doc?.status === 'pending_clearance';
  return (
    <main className="min-h-screen bg-surface grid justify-items-center content-start px-4 py-10">
      <div className="w-full max-w-[480px] grid gap-3.5 animate-rise" data-screen-label="Public · Verify document">
        <Kicker>{doc?.institution ?? 'Exatech'} · document verification</Kicker>
        {error && (
          <Card tone="ink" className="gap-2">
            <CardTitle>Not verified</CardTitle>
            <div className="text-[13px]">{error}</div>
          </Card>
        )}
        {doc && (
          <Card tone={good ? 'accent' : 'ink'} className="gap-2.5" data-testid="verify-card">
            <div className="flex justify-between items-start gap-2 flex-wrap">
              <div>
                <Kicker>{doc.title}</Kicker>
                <CardTitle className="text-[22px] break-all">{doc.number}</CardTitle>
              </div>
              <Tag variant={good ? 'accent' : 'ink'}>{doc.status === 'valid' ? 'Verified' : doc.status === 'pending_clearance' ? 'Verified · pending' : doc.status === 'voided' ? 'Voided' : doc.status === 'cancelled' ? 'Cancelled' : 'Not valid'}</Tag>
            </div>
            <div className="text-[13px] font-medium">{doc.statusLabel}</div>
            <div className="grid gap-1 text-[13px]">
              <Row>
                <span className="text-neutral-600">Amount</span>
                <span className="font-semibold tabular">{formatINR(doc.amount)}</span>
              </Row>
              <Row>
                <span className="text-neutral-600">Date</span>
                <span>{formatDate(doc.date)}</span>
              </Row>
              <Row>
                <span className="text-neutral-600">Branch</span>
                <span>{doc.branch}</span>
              </Row>
              <Row last>
                <span className="text-neutral-600">Student</span>
                <span>{doc.student}</span>
              </Row>
            </div>
          </Card>
        )}
        <div className="text-[11px] text-neutral-600">Scan the QR on any Exatech receipt, invoice or credit note to confirm it was issued by the institute. Student names are shortened for privacy.</div>
      </div>
    </main>
  );
}
