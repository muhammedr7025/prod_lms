import { teachingTodayContract } from '@exatech/contracts';
import { TodayScreen } from '@/features/teacher';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Today' };

export default function Page() {
  return (
    <Prefetch queries={[q(teachingTodayContract.today, {})]}>
      <TodayScreen />
    </Prefetch>
  );
}
