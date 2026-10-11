import { institutionRolesContract } from '@exatech/contracts';
import { RolesScreen } from '@/features/roles';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Roles & permissions' };

export default function Page() {
  return (
    <Prefetch queries={[q(institutionRolesContract.list, {})]}>
      <RolesScreen />
    </Prefetch>
  );
}
