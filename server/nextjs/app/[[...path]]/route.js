// Every path the core answers: the API, the webhook, the health checks and the front-end files.
//
// Where it sits: Next.js sends a request here unless a more specific route file (app/internal/...) matches. The core in
// ../node decides what the path means, so this file stays the same when routes are added there.
// `maxDuration` is the longest a live event stream (GET /api/events) may stay open; it must stay below the plan's limit
// (300 s on Hobby, up to 800 s on Pro) and the core closes its streams a little earlier (DC_EVENTS_MAX_STREAM_SECONDS).
import { handle } from '../../lib/core.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as HEAD, handle as OPTIONS };
