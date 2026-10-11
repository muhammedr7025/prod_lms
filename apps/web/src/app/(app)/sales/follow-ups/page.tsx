import { salesContract } from '@exatech/contracts';
import { FollowUpsScreen } from '@/features/sales/components/follow-ups-screen';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Follow-ups' };

export default function Page() {
  return (
    <Prefetch queries={[q(salesContract.followUps, {})]}>
      <FollowUpsScreen />
    </Prefetch>
  );
}
