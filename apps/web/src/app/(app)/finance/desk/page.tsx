import { financeContract } from '@exatech/contracts';
import { Suspense } from 'react';
import { DeskScreen } from '@/features/finance';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Collection desk' };

export default function Page() {
  return (
    <Prefetch queries={[q(financeContract.deskSession, { query: { counter: 'Counter 1' } })]}>
      <Suspense>
        <DeskScreen />
      </Suspense>
    </Prefetch>
  );
}
