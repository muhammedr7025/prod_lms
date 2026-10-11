import { admissionsContract } from '@exatech/contracts';
import { AdmissionsQueueScreen } from '@/features/admissions/components/admissions-queue';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Admissions' };

export default function Page() {
  return (
    <Prefetch queries={[q(admissionsContract.list, { query: { status: 'queue' } })]}>
      <AdmissionsQueueScreen />
    </Prefetch>
  );
}
