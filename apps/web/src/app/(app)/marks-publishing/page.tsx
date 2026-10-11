import { academicsMarksContract } from '@exatech/contracts';
import { MarksPublishingScreen } from '@/features/marks';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Marks publishing' };

export default function Page() {
  return (
    <Prefetch queries={[q(academicsMarksContract.list, {})]}>
      <MarksPublishingScreen />
    </Prefetch>
  );
}
