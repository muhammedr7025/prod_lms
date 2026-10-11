import { academicsTimetableContract } from '@exatech/contracts';
import { TimetableScreen } from '@/features/timetable/components/timetable-screen';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Timetable' };

export default function Page() {
  return (
    <Prefetch queries={[q(academicsTimetableContract.week, { query: {} })]}>
      <TimetableScreen />
    </Prefetch>
  );
}
