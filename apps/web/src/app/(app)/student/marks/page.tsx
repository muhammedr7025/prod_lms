import { portalContract } from '@exatech/contracts';
import { MarksScreen } from '@/features/portal/components/marks-screen';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Marks' };

export default function Page() {
  return (
    <Prefetch queries={[q(portalContract.marks, { query: {} })]}>
      <MarksScreen label="Student · Marks" />
    </Prefetch>
  );
}
