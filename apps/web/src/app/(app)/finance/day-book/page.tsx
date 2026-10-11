import { financeContract } from '@exatech/contracts';
import { DayBookScreen } from '@/features/finance';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Day book & closing' };

export default function Page() {
  return (
    <Prefetch queries={[q(financeContract.dayBook, { query: {} })]}>
      <DayBookScreen />
    </Prefetch>
  );
}
