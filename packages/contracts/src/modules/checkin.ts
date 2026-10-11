import { z } from 'zod';
import { route } from '../route';

/**
 * QR self check-in. The teacher shows a rotating 5-minute code (Teaching
 * module); students enter or scan it from the portal and are marked Present.
 * Implemented by the Teaching module; called by the student portal.
 */
export const checkinContract = {
  checkIn: route({
    method: 'POST',
    path: '/api/portal/checkin',
    body: z.object({ code: z.string().trim().min(4).max(64) }),
    response: z.object({ sessionLabel: z.string(), status: z.enum(['P', 'L']), alreadyMarked: z.boolean() }),
  }),
};
