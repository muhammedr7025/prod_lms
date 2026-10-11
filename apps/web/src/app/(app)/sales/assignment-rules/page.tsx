import { salesContract } from '@exatech/contracts';
import { RulesScreen } from '@/features/sales';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Assignment rules' };

export default function Page() {
  return (
    <Prefetch queries={[q(salesContract.rules, {})]}>
      <RulesScreen />
    </Prefetch>
  );
}
