import assets from 'stormsignal:assets';
import { handleAlerts } from './router.ts';
import { readsSettled } from './http.ts';

const aliases: Record<string, string> = {
  '/': '/index.html',
  '/resources/': '/resources/index.html',
  '/offline': '/offline.html',
  '/preparedness': '/preparedness.html',
};
const security = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), payment=()',
};
const bytes = (body: string) => Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
export default {
  async fetch(
    request: Request,
    _env?: unknown,
    ctx?: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/resources')
      return new Response(null, { status: 308, headers: { Location: '/resources/' } });
    if (url.pathname === '/api/alerts') {
      // As in pages.ts: on Workers a check and its shared reads must outlive their client.
      const response = handleAlerts(request);
      ctx?.waitUntil(response.then(readsSettled, readsSettled));
      return response;
    }
    if (!['GET', 'HEAD'].includes(request.method))
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    const path = aliases[url.pathname] ?? url.pathname;
    const asset = Object.hasOwn(assets, path) ? assets[path] : undefined;
    if (!asset) {
      // As on Pages: an unknown API path gets the API's plain 404, any other path the 404 page.
      const page = url.pathname.startsWith('/api/') ? undefined : assets['/404.html'];
      if (!page)
        return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
      return new Response(request.method === 'HEAD' ? null : bytes(page.body), {
        status: 404,
        headers: { 'Content-Type': page.type, 'Cache-Control': 'no-store', ...security },
      });
    }
    const headers = new Headers({
      'Content-Type': asset.type,
      ETag: asset.etag,
      'Cache-Control':
        path === '/app-version.json'
          ? 'no-store'
          : path.startsWith('/assets/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
      ...security,
    });
    if (request.headers.get('If-None-Match') === asset.etag)
      return new Response(null, { status: 304, headers });
    if (request.method === 'HEAD') return new Response(null, { headers });
    return new Response(bytes(asset.body), { headers });
  },
};
