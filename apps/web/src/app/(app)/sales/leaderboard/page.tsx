import { salesContract } from '@exatech/contracts';
import { LeaderboardScreen } from '@/features/sales/components/leaderboard-screen';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Targets & leaderboard' };

export default function Page() {
  return (
    <Prefetch queries={[q(salesContract.leaderboard, {})]}>
      <LeaderboardScreen />
    </Prefetch>
  );
}
