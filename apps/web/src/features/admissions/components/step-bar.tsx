'use client';

import type { AdmissionRow } from '@exatech/contracts';
import { cn } from '@exatech/ui';

/** Three-segment progress: Sales submitted → Finance verified → approval (Super Admin gate shown in ink). */
export function StepBar({ row, withLabel = false }: { row: AdmissionRow; withLabel?: boolean }) {
  const submitted = row.status !== 'draft';
  const s3 =
    row.status === 'approved'
      ? 'bg-accent'
      : row.financeVerified && row.needsSuperAdmin && !row.superAdminApproved
        ? 'bg-ink'
        : row.financeVerified && !row.approveBlockedReason
          ? 'bg-accent-300'
          : 'bg-accent-100';
  return (
    <div>
      <div className="flex gap-[3px]" aria-hidden>
        <span className={cn('w-[22px] h-[5px]', submitted ? 'bg-accent' : 'bg-accent-100')} />
        <span className={cn('w-[22px] h-[5px]', row.financeVerified || row.status === 'approved' ? 'bg-accent' : 'bg-accent-100')} />
        <span className={cn('w-[22px] h-[5px]', s3)} />
      </div>
      {withLabel ? <div className="text-[11px] text-neutral-600 mt-[3px]">{row.stepLabel}</div> : <span className="sr-only">{row.stepLabel}</span>}
    </div>
  );
}
