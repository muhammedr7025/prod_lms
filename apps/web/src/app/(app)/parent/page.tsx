import { portalContract } from '@exatech/contracts';
import { ParentHome } from '@/features/portal';
import { Prefetch, q, type PrefetchEntry } from '@/lib/prefetch';

export const metadata = { title: 'Home' };

/** The child comes from ?child= (the switcher also remembers it in localStorage). */
export default async function Page({ searchParams }: { searchParams: Promise<{ child?: string }> }) {
  const { child } = await searchParams;
  const queries: PrefetchEntry[] = [q(portalContract.children, {})];
  if (child) queries.push(q(portalContract.home, { query: { studentId: child } }));
  return (
    <Prefetch queries={queries}>
      <ParentHome />
    </Prefetch>
  );
}
