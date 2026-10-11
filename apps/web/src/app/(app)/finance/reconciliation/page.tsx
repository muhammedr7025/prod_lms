import { financeContract } from '@exatech/contracts';
import { ReconciliationScreen } from '@/features/finance';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Reconciliation' };

export default function Page() {
  return (
    <Prefetch queries={[q(financeContract.reconciliation, { query: {} })]}>
      <ReconciliationScreen />
    </Prefetch>
  );
}
