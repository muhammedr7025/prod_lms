import { academicsMaterialsContract } from '@exatech/contracts';
import { NotesScreen } from '@/features/academics';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Notes & material' };

export default function Page() {
  return (
    <Prefetch queries={[q(academicsMaterialsContract.list, {})]}>
      <NotesScreen />
    </Prefetch>
  );
}
