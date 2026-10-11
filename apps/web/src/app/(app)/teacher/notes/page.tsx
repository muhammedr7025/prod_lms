import { teachingMaterialsContract } from '@exatech/contracts';
import { NotesScreen } from '@/features/teacher';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Notes & material' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Page({ searchParams }: { searchParams: Promise<{ batch?: string }> }) {
  const sp = await searchParams;
  const batchId = sp.batch && UUID.test(sp.batch) ? sp.batch : undefined;
  return (
    <Prefetch queries={[q(teachingMaterialsContract.list, { query: batchId ? { batchId } : {} })]}>
      <NotesScreen batchId={batchId} />
    </Prefetch>
  );
}
