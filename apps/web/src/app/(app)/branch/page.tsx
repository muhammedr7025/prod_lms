import { academicsOverviewContract } from '@exatech/contracts';
import { BranchOpsScreen } from '@/features/academics/components/branch-ops-screen';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Branch operations' };

export default function Page() {
  return (
    <Prefetch queries={[q(academicsOverviewContract.overview, {})]}>
      <BranchOpsScreen />
    </Prefetch>
  );
}
