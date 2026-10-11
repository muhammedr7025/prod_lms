import { financeContract } from '@exatech/contracts';
import { AccountScreen } from '@/features/finance/components/account-screen';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Fee account' };

export default async function Page({ params }: { params: Promise<{ enrollmentId: string }> }) {
  const { enrollmentId } = await params;
  return (
    <Prefetch queries={[q(financeContract.account, { params: { enrollmentId } })]}>
      <AccountScreen enrollmentId={enrollmentId} />
    </Prefetch>
  );
}
