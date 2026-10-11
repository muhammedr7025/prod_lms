import { teachingAssignmentsContract } from '@exatech/contracts';
import { AssignmentsScreen } from '@/features/teacher';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Assignments' };

export default function Page() {
  return (
    <Prefetch queries={[q(teachingAssignmentsContract.list, { query: {} })]}>
      <AssignmentsScreen />
    </Prefetch>
  );
}
