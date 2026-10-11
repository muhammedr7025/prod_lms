import { academicsBatchesContract } from '@exatech/contracts';
import { BatchesScreen } from '@/features/academics/components/batches-screen';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Courses & batches' };

export default function Page() {
  return (
    <Prefetch queries={[q(academicsBatchesContract.list, {})]}>
      <BatchesScreen />
    </Prefetch>
  );
}
