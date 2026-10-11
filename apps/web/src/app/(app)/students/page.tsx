import { academicsStudentsContract } from '@exatech/contracts';
import { StudentsScreen } from '@/features/students';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Students' };

export default function Page() {
  return (
    <Prefetch queries={[q(academicsStudentsContract.list, { query: { limit: 50 } })]}>
      <StudentsScreen />
    </Prefetch>
  );
}
