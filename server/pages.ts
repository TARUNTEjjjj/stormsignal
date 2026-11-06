import { handleAlerts } from './router.ts';

interface PagesEnvironment {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

// Only /api/* invokes this Worker in production; Pages serves static files directly.
export default {
  async fetch(request: Request, env: PagesEnvironment): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/api/alerts') return handleAlerts(request);
    if (path.startsWith('/api/'))
      return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    return env.ASSETS.fetch(request);
  },
};
