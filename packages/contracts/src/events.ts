/**
 * Domain events (PRD §13). Modules integrate through events, never by
 * writing another module's tables.
 *
 * Two delivery modes, both from one `events.emit(tx, type, payload)` call:
 *  - in-transaction subscribers (consistency: enrollment, invoice schedule,
 *    seat count, fee clearance) run inside the same DB transaction;
 *  - the transactional outbox relays the event to the worker for side
 *    effects (notifications, WhatsApp/email, PDFs, invites, SSE).
 */
export interface DomainEvents {
  LeadCreated: { leadId: string; branchId: string; ownerUserId: string | null; source: string };
  LeadStageChanged: { leadId: string; branchId: string; from: string; to: string; actorUserId: string | null };
  ApplicationSubmitted: { admissionId: string; branchId: string; salesUserId: string; leadId: string | null };
  FeeTermsVerified: { admissionId: string; branchId: string; actorUserId: string };
  DiscountApproved: { admissionId: string; branchId: string; actorUserId: string; pct: number };
  AdmissionReturned: { admissionId: string; branchId: string; actorUserId: string; to: 'sales' | 'finance'; note: string };
  AdmissionApproved: {
    admissionId: string;
    branchId: string;
    studentId: string;
    enrollmentId: string;
    batchId: string;
    leadId: string | null;
    salesUserId: string;
    admissionNo: string;
    studentUserId: string | null;
    guardianUserIds: string[];
    feePlanId: string;
    discountPct: number;
    joinedOn: string;
    actorUserId: string;
  };
  PaymentRecorded: { paymentId: string; enrollmentId: string; studentId: string; branchId: string; amount: number; status: string; channel: string; receiptId: string | null };
  PaymentCleared: { paymentId: string; enrollmentId: string; branchId: string };
  PaymentVoided: { paymentId: string; enrollmentId: string; branchId: string; reason: string };
  ReceiptIssued: { receiptId: string; paymentId: string; enrollmentId: string; number: string };
  InvoiceIssued: { invoiceId: string; enrollmentId: string; number: string };
  FeeClearanceChanged: { enrollmentId: string; studentId: string; cleared: boolean };
  SessionCreated: { sessionId: string; branchId: string; batchId: string };
  SessionUpdated: { sessionId: string; branchId: string; batchId: string; changes: string[] };
  SessionRemoved: { sessionId: string; branchId: string; batchId: string };
  SubstituteAssigned: { sessionId: string; branchId: string; batchId: string; teacherUserId: string; originalTeacherUserId: string };
  AttendanceSubmitted: { sessionId: string; branchId: string; batchId: string; absentEnrollmentIds: string[]; present: number; absent: number };
  AdhocSessionStarted: { sessionId: string; branchId: string; batchId: string; teacherUserId: string; regularTeacherUserId: string | null; reason: string };
  MarksSubmitted: { examId: string; branchId: string; batchId: string };
  MarksReturned: { examId: string; branchId: string; batchId: string; note: string };
  MarksPublished: { examId: string; branchId: string; batchId: string };
  AssignmentCreated: { assignmentId: string; batchId: string; branchId: string };
  SubmissionReceived: { submissionId: string; assignmentId: string; enrollmentId: string };
  GradesReleased: { assignmentId: string; batchId: string; submissionIds: string[] };
  MaterialUploaded: { materialId: string; batchId: string; branchId: string };
  MaterialVisibilityChanged: { materialId: string; batchId: string; visibility: string };
  AnnouncementPublished: { announcementId: string; branchId: string | null };
  LeaveRequested: { leaveId: string; userId: string; branchId: string; date: string };
  LeaveDecided: { leaveId: string; userId: string; branchId: string; date: string; status: 'approved' | 'rejected' };
  BatchTransferred: { fromEnrollmentId: string; toEnrollmentId: string; studentId: string; adjustment: number };
  ApprovalRequested: { approvalId: string; kind: string; level: string; branchId: string | null };
  ApprovalDecided: { approvalId: string; kind: string; status: string; entityId: string };
}

export type DomainEventType = keyof DomainEvents;

export interface DomainEventEnvelope<T extends DomainEventType = DomainEventType> {
  id: string;
  type: T;
  payload: DomainEvents[T];
  occurredAt: string;
}

/** Realtime (SSE) message kinds pushed to clients to invalidate queries. */
export interface RealtimeMessage {
  kind: 'notification' | 'invalidate';
  /** Query-key prefixes to invalidate, e.g. ["finance"], ["students", id]. */
  keys?: string[][];
  notification?: { id: string; title: string; body: string; category: string; link: string | null; createdAt: string };
}
