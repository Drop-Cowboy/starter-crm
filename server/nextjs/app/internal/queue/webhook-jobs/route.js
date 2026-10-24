// The Vercel Queues consumer: Vercel calls this route with each event id of the `starter-crm-webhook-jobs` topic.
//
// Where it sits: `vercel.json` binds this file to the topic (`queue/v2beta`), and Vercel keeps such routes private, so
// only its queue can call it. The core runs the event's handlers here and fails the delivery when another attempt is due.
// The route is a file of its own only because a trigger names a file; it forwards to the same core as everything else.
import { handle } from '../../../../lib/core.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export { handle as POST };
