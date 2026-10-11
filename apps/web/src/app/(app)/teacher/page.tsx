import { teachingTodayContract } from '@exatech/contracts';
import { TodayScreen } from '@/features/teacher/components/today-screen';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Today' };

export default function Page() {
  return (
    <Prefetch queries={[q(teachingTodayContract.today, {})]}>
      <TodayScreen />
    </Prefetch>
  );
}
