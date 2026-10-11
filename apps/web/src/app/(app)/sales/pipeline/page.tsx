import { salesContract } from '@exatech/contracts';
import { Suspense } from 'react';
import { PipelineScreen } from '@/features/sales/components/pipeline-screen';
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
