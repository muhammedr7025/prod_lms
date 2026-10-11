import { portalContract } from '@exatech/contracts';
import { FeesScreen } from '@/features/portal/components/fees-screen';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Fees' };

export default function Page() {
  return (
    <Prefetch queries={[q(portalContract.fees, { query: {} })]}>
      <FeesScreen label="Student · Fees" />
    </Prefetch>
  );
}
