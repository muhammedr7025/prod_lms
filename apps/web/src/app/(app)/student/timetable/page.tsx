import { portalContract } from '@exatech/contracts';
import { TimetableScreen } from '@/features/portal/components/timetable-screen';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Timetable' };

export default function Page() {
  return (
    <Prefetch queries={[q(portalContract.timetable, { query: {} })]}>
      <TimetableScreen />
    </Prefetch>
  );
}
