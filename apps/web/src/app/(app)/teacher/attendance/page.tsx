import { teachingAttendanceContract } from '@exatech/contracts';
import { AttendanceScreen } from '@/features/teacher/components/attendance-screen';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Attendance' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Page({ searchParams }: { searchParams: Promise<{ session?: string }> }) {
  const sp = await searchParams;
  const session = sp.session && UUID.test(sp.session) ? sp.session : undefined;
  return (
    <Prefetch queries={[q(teachingAttendanceContract.get, { query: session ? { session } : {} })]}>
      <AttendanceScreen sessionId={session} />
    </Prefetch>
  );
}
