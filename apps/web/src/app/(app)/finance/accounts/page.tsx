import { financeContract } from '@exatech/contracts';
import { AccountsScreen } from '@/features/finance/components/accounts-screen';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Student fee accounts' };

export default function Page() {
  return (
    <Prefetch queries={[q(financeContract.accounts, { query: { filter: 'all', limit: 50 } })]}>
      <AccountsScreen />
    </Prefetch>
  );
}
