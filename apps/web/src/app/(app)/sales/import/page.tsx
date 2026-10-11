import { Suspense } from 'react';
import { ImportScreen } from '@/features/sales/components/import-screen';

export const metadata = { title: 'Import leads' };

export default function Page() {
  return (
    <Suspense>
      <ImportScreen />
    </Suspense>
  );
}
