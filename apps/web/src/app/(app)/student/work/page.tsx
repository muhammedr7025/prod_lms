import { portalContract } from '@exatech/contracts';
import { WorkScreen } from '@/features/portal';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Work' };

export default function Page() {
  return (
    <Prefetch queries={[q(portalContract.work, {})]}>
      <WorkScreen />
    </Prefetch>
  );
}
