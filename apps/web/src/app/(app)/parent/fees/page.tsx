import { portalContract } from '@exatech/contracts';
import { ParentFees } from '@/features/portal/components/parent-screens';
import { Prefetch, q, type PrefetchEntry } from '@/lib/prefetch';

export const metadata = { title: 'Fees' };

/** The child comes from ?child= (the switcher also remembers it in localStorage). */
export default async function Page({ searchParams }: { searchParams: Promise<{ child?: string }> }) {
  const { child } = await searchParams;
  const queries: PrefetchEntry[] = [q(portalContract.children, {})];
  if (child) queries.push(q(portalContract.fees, { query: { studentId: child } }));
  return (
    <Prefetch queries={queries}>
      <ParentFees />
    </Prefetch>
  );
}
