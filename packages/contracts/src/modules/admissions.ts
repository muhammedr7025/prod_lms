import { z } from 'zod';
import { route, zDate, zId, zInstant, zOk, zPaise } from '../route';

/**
 * Admissions (implemented by the Sales/Admissions module). The approval chain
 * is Sales submits → Finance verifies fee terms (step 2, Finance dashboard) →
 * Super Admin approves discounts above the threshold → Branch Admin approves.
 * Each gate blocks the next (PRD §12 rule 1).
 */
export const ADMISSION_STATUSES = ['draft', 'submitted', 'fee_verified', 'approved', 'returned', 'waitlisted', 'cancelled'] as const;
export type AdmissionStatus = (typeof ADMISSION_STATUSES)[number];

export const zAdmissionRow = z.object({
  id: zId,
  status: z.enum(ADMISSION_STATUSES),
  studentName: z.string(),
  guardianLine: z.string(), // "Suresh Babu · father"
  branchId: zId,
  batchId: zId,
  batchCode: z.string(),
  courseName: z.string(),
  seatsLine: z.string(), // "2 seats left" / "0 seats left · waitlist"
  seatsLeft: z.number().int(),
  waitlist: z.boolean(),
  salesName: z.string(),
  planLine: z.string(), // "3 instalments 40/30/30 · ₹72,000"
  total: zPaise,
  discountPct: z.number(),
  discountAmount: zPaise,
  needsSuperAdmin: z.boolean(),
  financeVerified: z.boolean(),
  superAdminApproved: z.boolean(),
  /** Why Approve is disabled (null when it can be approved). */
  approveBlockedReason: z.string().nullable(),
  stepLabel: z.string(), // "Awaiting Finance", "Awaiting Super Admin", "Ready for approval", "Approved"
  docs: z.object({ uploaded: z.number().int(), required: z.number().int(), missing: z.array(z.string()) }),
  returnNote: z.string().nullable(),
  returnedTo: z.enum(['sales', 'finance']).nullable(),
  admissionNo: z.string().nullable(),
  submittedAt: zInstant.nullable(),
  leadId: zId.nullable(),
});
export type AdmissionRow = z.output<typeof zAdmissionRow>;

export const zAdmissionDetail = zAdmissionRow.extend({
  studentPhone: z.string().nullable(),
  studentEmail: z.string().nullable(),
  studentDob: zDate.nullable(),
  studentAddress: z.string().nullable(),
  guardianName: z.string().nullable(),
  guardianRelationship: z.string().nullable(),
  guardianPhone: z.string().nullable(),
  guardianEmail: z.string().nullable(),
  feePlanId: zId,
  discountReason: z.string().nullable(),
  quote: z.object({ subtotal: zPaise, discount: zPaise, taxable: zPaise, gst: zPaise, total: zPaise, gstRate: z.number() }).nullable(),
  consent: z.object({ dpdp: z.boolean(), purposes: z.array(z.string()), parental: z.boolean() }).nullable(),
  referralCode: z.string().nullable(),
  documents: z.array(z.object({ id: zId, kind: z.string(), label: z.string(), status: z.string(), fileId: zId.nullable() })),
  history: z.array(z.object({ at: zInstant, step: z.string(), action: z.string(), actor: z.string(), note: z.string().nullable() })),
});
export type AdmissionDetail = z.output<typeof zAdmissionDetail>;

export const zAdmissionInput = z.object({
  leadId: zId.nullable().optional(),
  studentName: z.string().trim().min(2, 'Enter the student’s full name'),
  studentPhone: z.string().trim().min(10, 'Enter a valid 10-digit mobile'),
  studentEmail: z.string().trim().email('Enter a valid email').nullable().optional(),
  studentDob: zDate.nullable().optional(),
  studentAddress: z.string().trim().nullable().optional(),
  guardianName: z.string().trim().nullable().optional(),
  guardianRelationship: z.string().trim().nullable().optional(),
  guardianPhone: z.string().trim().nullable().optional(),
  guardianEmail: z.string().trim().email('Enter a valid email').nullable().optional(),
  batchId: zId,
  feePlanId: zId,
  discountPct: z.number().min(0).max(100).default(0),
  discountReason: z.string().trim().nullable().optional(),
  waitlist: z.boolean().default(false),
  consent: z.object({ dpdp: z.boolean(), purposes: z.array(z.string()), parental: z.boolean() }),
  referralCode: z.string().trim().nullable().optional(),
  documents: z.array(z.object({ kind: z.enum(['id_proof', 'photo', 'certificate', 'other']), label: z.string(), fileId: zId.nullable() })).default([]),
});
export type AdmissionInput = z.input<typeof zAdmissionInput>;

export const admissionsContract = {
  /** Queue for the current branch scope. status=queue → submitted + fee_verified (awaiting someone). */
  list: route({
    method: 'GET',
    path: '/api/admissions',
    query: z.object({ status: z.enum(['queue', 'awaiting_finance', 'awaiting_approval', 'returned', 'approved', 'waitlist', 'mine']).default('queue') }),
    response: z.object({ items: z.array(zAdmissionRow), counts: z.record(z.string(), z.number().int()) }),
  }),
  get: route({ method: 'GET', path: '/api/admissions/:id', response: zAdmissionDetail }),
  /** Sales: create and submit (or save a draft). */
  submit: route({ method: 'POST', path: '/api/admissions', body: zAdmissionInput.extend({ draft: z.boolean().default(false) }), response: zAdmissionDetail }),
  /** Sales: edit a draft/returned application and (re)submit. */
  update: route({ method: 'PUT', path: '/api/admissions/:id', body: zAdmissionInput.extend({ draft: z.boolean().default(false) }), response: zAdmissionDetail }),
  /** Finance (step 2): verify plan, discount and documents. Above the Super Admin threshold this raises an approval request. */
  verifyFee: route({ method: 'POST', path: '/api/admissions/:id/verify-fee', body: z.object({ note: z.string().trim().max(500).optional() }), response: zAdmissionRow }),
  /** Finance → Sales, or Branch Admin → Sales/Finance, with a note. */
  returnApp: route({
    method: 'POST',
    path: '/api/admissions/:id/return',
    body: z.object({ to: z.enum(['sales', 'finance']).default('sales'), note: z.string().trim().min(3, 'Add a note for the person fixing it') }),
    response: zAdmissionRow,
  }),
  /** Branch Admin final approval → AdmissionApproved (enrollment, invoices, accounts, seat, lead Won). */
  approve: route({ method: 'POST', path: '/api/admissions/:id/approve', response: zAdmissionRow }),
  cancel: route({ method: 'POST', path: '/api/admissions/:id/cancel', body: z.object({ reason: z.string().trim().min(3) }), response: zOk }),
};
