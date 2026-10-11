import { z } from 'zod';
import { route, zId, zInstant } from '../route';

/**
 * Staff side of parent communication (PRD §10): parents message the class
 * teacher (moderated by the Branch Admin, answered by the teacher) and
 * request PTM slots (confirmed or declined by the teacher or Branch Admin).
 */
export const zParentMessageItem = z.object({
  id: zId,
  parentName: z.string(),
  studentName: z.string(),
  batchCode: z.string(),
  teacherName: z.string().nullable(),
  body: z.string(),
  status: z.enum(['pending', 'delivered', 'rejected']),
  reply: z.string().nullable(),
  createdAt: zInstant,
});
export type ParentMessageItem = z.output<typeof zParentMessageItem>;

export const zPtmItem = z.object({
  id: zId,
  parentName: z.string(),
  studentName: z.string(),
  batchCode: z.string(),
  slotLabel: z.string(),
  note: z.string().nullable(),
  status: z.enum(['requested', 'confirmed', 'declined']),
  createdAt: zInstant,
});
export type PtmItem = z.output<typeof zPtmItem>;

export const parentRequestsContract = {
  /** Branch Admin: messages awaiting moderation + open PTM requests in scope. Teacher: delivered, unanswered messages + PTM requests for their batches. */
  inbox: route({
    method: 'GET',
    path: '/api/comms/parent-requests',
    response: z.object({ role: z.enum(['moderator', 'teacher']), messages: z.array(zParentMessageItem), ptm: z.array(zPtmItem) }),
  }),
  moderate: route({
    method: 'POST',
    path: '/api/comms/parent-messages/:id/moderate',
    body: z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(300).optional() }),
    response: zParentMessageItem,
  }),
  reply: route({
    method: 'POST',
    path: '/api/comms/parent-messages/:id/reply',
    body: z.object({ reply: z.string().trim().min(2, 'Write a reply').max(1000) }),
    response: zParentMessageItem,
  }),
  decidePtm: route({
    method: 'POST',
    path: '/api/comms/ptm/:id/decide',
    body: z.object({ decision: z.enum(['confirmed', 'declined']), note: z.string().trim().max(300).optional() }),
    response: zPtmItem,
  }),
};
