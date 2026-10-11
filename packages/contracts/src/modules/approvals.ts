import { z } from 'zod';
import { route, zId, zInstant, zPaise } from '../route';

/**
 * Approvals above thresholds (Super Admin queue, PRD §5). Requests are raised
 * by the module that needs them (Admissions: discount > 20 %; Finance:
 * locked-period entries, refunds, voids, restructures, exemptions).
 * Deciding emits `ApprovalDecided` in the same transaction; the owning module
 * applies the effect in its `events.onTx('ApprovalDecided', …)` handler.
 */
export const APPROVAL_KINDS = ['discount', 'locked_period', 'refund', 'restructure', 'waiver', 'void', 'exemption'] as const;

export const zApproval = z.object({
  id: zId,
  kind: z.enum(APPROVAL_KINDS),
  level: z.enum(['finance', 'super_admin']),
  status: z.enum(['pending', 'approved', 'returned', 'denied']),
  title: z.string(),
  summary: z.string(),
  entityType: z.string(),
  entityId: zId,
  amount: zPaise.nullable(),
  pct: z.number().nullable(),
  branchId: zId.nullable(),
  branchName: z.string().nullable(),
  requestedByName: z.string(),
  requestedAt: zInstant,
  decidedByName: z.string().nullable(),
  decidedAt: zInstant.nullable(),
  decisionNote: z.string().nullable(),
});
export type Approval = z.output<typeof zApproval>;

export const approvalsContract = {
  list: route({
    method: 'GET',
    path: '/api/approvals',
    query: z.object({ status: z.enum(['pending', 'decided', 'all']).default('pending'), level: z.enum(['finance', 'super_admin']).optional() }),
    response: z.array(zApproval),
  }),
  /** Approve, or Return (for discounts: back to the requester) / Deny (others). A note is required unless approving. */
  decide: route({
    method: 'POST',
    path: '/api/approvals/:id/decide',
    body: z.object({ decision: z.enum(['approved', 'returned', 'denied']), note: z.string().trim().max(500).optional() }),
    response: zApproval,
  }),
};
