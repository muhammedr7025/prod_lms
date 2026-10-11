import { financeContract } from '@exatech/contracts';
import { DuesScreen } from '@/features/finance';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Dues & follow-up' };

export default function Page() {
  return (
    <Prefetch queries={[q(financeContract.dues, { query: { bucket: 'all', promise: 'any' } })]}>
      <DuesScreen />
    </Prefetch>
  );
}
