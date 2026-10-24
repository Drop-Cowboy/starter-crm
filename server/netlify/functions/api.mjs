// Every request Netlify's CDN cannot answer with a file: the API, the webhook, the internal routes, the health checks,
// and the pages a front-end routes on the client.
//
// Where it sits: Netlify serves the front-ends from its CDN, out of the folder scripts/build.mjs assembles, and runs
// this function for any path that is not a file there (`preferStatic`). The core answers it exactly as the Node server
// would: a route, the index page for a client-side route, a redirect for a folder without its slash, or a 404 for a
// missing file. lib/core.js boots the core once per instance. What a customer changes: nothing.
import { handle } from '../lib/core.js';

export default async (request, context) => handle(request, context);

export const config = {
    path: '/*',
    preferStatic: true
};
