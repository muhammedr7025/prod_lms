import { commsContract, portalContract } from '@exatech/contracts';
import { StudentHome } from '@/features/portal';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Home' };

export default function Page() {
  return (
    <Prefetch queries={[q(portalContract.home, { query: {} }), q(commsContract.feed, {})]}>
      <StudentHome />
    </Prefetch>
  );
}
