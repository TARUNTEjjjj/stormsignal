import assets from 'stormsignal:assets';
import { handleAlerts } from './router.ts';

const aliases: Record<string, string> = {
  '/': '/index.html',
  '/offline': '/offline.html',
  '/preparedness': '/preparedness.html',
};
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/alerts') return handleAlerts(request);
    if (!['GET', 'HEAD'].includes(request.method))
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    const path = aliases[url.pathname] ?? url.pathname;
    const asset = Object.hasOwn(assets, path) ? assets[path] : undefined;
    if (!asset)
      return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    const headers = new Headers({
      'Content-Type': asset.type,
      ETag: asset.etag,
      'Cache-Control': path.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), payment=()',
    });
    if (request.headers.get('If-None-Match') === asset.etag)
      return new Response(null, { status: 304, headers });
    if (request.method === 'HEAD') return new Response(null, { headers });
    const data = Uint8Array.from(atob(asset.body), (c) => c.charCodeAt(0));
    return new Response(data, { headers });
  },
};
