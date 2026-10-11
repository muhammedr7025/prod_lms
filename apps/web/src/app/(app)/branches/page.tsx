import { institutionBranchesContract } from '@exatech/contracts';
import { BranchesScreen } from '@/features/branches';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Branches' };

export default function Page() {
  return (
    <Prefetch queries={[q(institutionBranchesContract.list, {})]}>
      <BranchesScreen />
    </Prefetch>
  );
}
