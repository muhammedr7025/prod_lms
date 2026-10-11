import { salesContract } from '@exatech/contracts';
import { FunnelScreen } from '@/features/sales/components/funnel-screen';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Funnel' };

export default function Page() {
  return (
    <Prefetch queries={[q(salesContract.funnel, { query: {} })]}>
      <FunnelScreen />
    </Prefetch>
  );
}
