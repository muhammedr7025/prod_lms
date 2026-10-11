import { financeContract } from '@exatech/contracts';
import { FinanceSettingsScreen } from '@/features/finance/components/settings-screen';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Finance settings' };

export default function Page() {
  return (
    <Prefetch queries={[q(financeContract.settings, {})]}>
      <FinanceSettingsScreen />
    </Prefetch>
  );
}
