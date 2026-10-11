import { commsContract } from '@exatech/contracts';
import { AnnouncementsScreen } from '@/features/announcements';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Announcements' };

export default function Page() {
  return (
    <Prefetch queries={[q(commsContract.list, {})]}>
      <AnnouncementsScreen />
    </Prefetch>
  );
}
