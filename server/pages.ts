import { handleAlerts } from './router.ts';
import { readsSettled } from './http.ts';

interface PagesEnvironment {
  ASSETS: { fetch(request: Request): Promise<Response> };
}
/** The part of the Workers execution context used here. Node callers (build checks) pass none. */
interface PagesContext {
  waitUntil(promise: Promise<unknown>): void;
}

// Only /api/* invokes this Worker in production; Pages serves static files directly.
export default {
  async fetch(request: Request, env: PagesEnvironment, ctx?: PagesContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/api/alerts') {
      // Workers cancel a request's timers and subrequests once its client has gone or its
      // response has been sent, and cancelled code never resumes. A shared read (http.ts) would
      // then never settle and would block its source for every later check, and the check's
      // admission (router.ts) would never be released. Keep the check, and the reads in progress
      // when it ends, alive until they settle: at most 18 s for the check and 8.4 s for a read,
      // inside the 30 s that waitUntil allows.
      const response = handleAlerts(request);
      ctx?.waitUntil(response.then(readsSettled, readsSettled));
      return response;
    }
    if (path.startsWith('/api/'))
      return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    return env.ASSETS.fetch(request);
  },
};
