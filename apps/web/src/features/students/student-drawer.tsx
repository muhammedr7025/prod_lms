'use client';

import { DrawerLayout } from '@/components/drawers/drawer-host';

/** Placeholder — replaced by the feature implementation. */
export default function StudentDrawer({ id }: { id: string }) {
  return (
    <DrawerLayout kicker="Student" title="Student details">
      <div className="text-[13px] text-neutral-600">Record {id}</div>
    </DrawerLayout>
  );
}
