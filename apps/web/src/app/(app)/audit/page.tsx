import { auditContract } from '@exatech/contracts';
import { AuditLogScreen } from '@/features/audit';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Audit log' };

/** Reference pattern: thin route → server prefetch of the primary query → feature screen. */
export default function Page() {
  return (
    <Prefetch queries={[q(auditContract.list, { query: { range: '24h', limit: 50 } })]}>
      <AuditLogScreen />
    </Prefetch>
  );
}
