import { approvalsContract, institutionContract } from '@exatech/contracts';
import { OverviewScreen } from '@/features/institution/components/overview-screen';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Overview' };

export default function Page() {
  return (
    <Prefetch queries={[q(institutionContract.overview, {}), q(approvalsContract.list, { query: { status: 'pending', level: 'super_admin' } })]}>
      <OverviewScreen />
    </Prefetch>
  );
}
