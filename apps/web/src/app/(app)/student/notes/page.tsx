import { portalContract } from '@exatech/contracts';
import { NotesScreen } from '@/features/portal/components/notes-screen';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Notes' };

export default function Page() {
  return (
    <Prefetch queries={[q(portalContract.notes, { query: {} })]}>
      <NotesScreen />
    </Prefetch>
  );
}
