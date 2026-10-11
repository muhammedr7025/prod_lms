import { salesContract } from '@exatech/contracts';
import { Suspense } from 'react';
import { LeadsScreen } from '@/features/sales';
import { Prefetch, q, type PrefetchEntry } from '@/lib/prefetch';

export const metadata = { title: 'Leads' };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const lead = typeof sp.lead === 'string' && /^[0-9a-f-]{36}$/i.test(sp.lead) ? sp.lead : null;
  const queries: PrefetchEntry[] = [q(salesContract.leads, { query: {} })];
  if (lead) queries.push(q(salesContract.getLead, { params: { id: lead } }));
  return (
    <Prefetch queries={queries}>
      <Suspense>
        <LeadsScreen />
      </Suspense>
    </Prefetch>
  );
}
