import { admissionsContract, salesContract } from '@exatech/contracts';
import { Suspense } from 'react';
import { AdmissionWizard } from '@/features/admissions/components/admission-wizard';
import { Prefetch, q, type PrefetchEntry } from '@/lib/prefetch';

export const metadata = { title: 'New admission' };

const UUID = /^[0-9a-f-]{36}$/i;

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const queries: PrefetchEntry[] = [q(salesContract.admissionOptions, {}), q(admissionsContract.list, { query: { status: 'mine' } })];
  if (typeof sp.lead === 'string' && UUID.test(sp.lead)) queries.push(q(salesContract.getLead, { params: { id: sp.lead } }));
  if (typeof sp.id === 'string' && UUID.test(sp.id)) queries.push(q(admissionsContract.get, { params: { id: sp.id } }));
  return (
    <Prefetch queries={queries}>
      <Suspense>
        <AdmissionWizard />
      </Suspense>
    </Prefetch>
  );
}
