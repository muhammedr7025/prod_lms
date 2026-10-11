import { portalContract } from '@exatech/contracts';
import { ParentAlerts } from '@/features/portal/components/parent-screens';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Alerts' };

export default function Page() {
  return (
    <Prefetch queries={[q(portalContract.children, {}), q(portalContract.alerts, {})]}>
      <ParentAlerts />
    </Prefetch>
  );
}
