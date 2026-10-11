import { institutionStaffContract } from '@exatech/contracts';
import { StaffScreen } from '@/features/staff/components/staff-screen';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Staff & teachers' };

export default function Page() {
  return (
    <Prefetch queries={[q(institutionStaffContract.list, {})]}>
      <StaffScreen />
    </Prefetch>
  );
}
