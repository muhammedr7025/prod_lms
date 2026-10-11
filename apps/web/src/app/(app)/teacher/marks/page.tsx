import { teachingMarksContract } from '@exatech/contracts';
import { MarksScreen } from '@/features/teacher/components/marks-screen';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Marks entry' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Page({ searchParams }: { searchParams: Promise<{ exam?: string }> }) {
  const sp = await searchParams;
  const examId = sp.exam && UUID.test(sp.exam) ? sp.exam : undefined;
  return (
    <Prefetch queries={[q(teachingMarksContract.exams, {}), ...(examId ? [q(teachingMarksContract.exam, { params: { id: examId } })] : [])]}>
      <MarksScreen examId={examId} />
    </Prefetch>
  );
}
