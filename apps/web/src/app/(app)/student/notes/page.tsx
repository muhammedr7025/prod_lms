import { portalContract } from '@exatech/contracts';
import { NotesScreen } from '@/features/portal';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Notes' };

export default function Page() {
  return (
    <Prefetch queries={[q(portalContract.notes, { query: {} })]}>
      <NotesScreen />
    </Prefetch>
  );
}
