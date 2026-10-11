import { salesContract } from '@exatech/contracts';
import { Suspense } from 'react';
import { PipelineScreen } from '@/features/sales';
import { Prefetch, q } from '@/lib/prefetch';

export const metadata = { title: 'Pipeline' };

export default function Page() {
  return (
    <Prefetch queries={[q(salesContract.pipeline, {})]}>
      <Suspense>
        <PipelineScreen />
      </Suspense>
    </Prefetch>
  );
}
