import { admissionsContract, financeContract } from '@exatech/contracts';
import { FinanceDashboardScreen } from '@/features/finance';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Finance' };

export default function Page() {
  return (
    <Prefetch queries={[q(financeContract.dashboard, {}), q(admissionsContract.list, { query: { status: 'awaiting_finance' } })]}>
      <FinanceDashboardScreen />
    </Prefetch>
  );
}
