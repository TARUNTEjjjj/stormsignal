/** Fixed public warning origins only; this is never a general-purpose proxy. */
export interface TextOptions {
  maxBytes?: number;
  ttlMs?: number;
  signal?: AbortSignal;
}
export interface TextResult {
  text: string;
  fetchedAt: number;
  etag?: string;
}
const memory = new Map<string, TextResult>();
const pending = new Map<string, Promise<TextResult>>();
const MAX_ENTRIES = 96;
const MAX_MEMORY_BYTES = 12_000_000;
const RETENTION = 24 * 60 * 60_000;

function allowed(target: string): URL {
  if (target.split('?')[0].includes('\\') || /%(?:2f|5c|2e|25)/i.test(target.split('?')[0]))
    throw new Error('Unsupported warning source');
  const u = new URL(target);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash)
    throw new Error('Unsupported warning source');
  const ok =
    u.hostname === 'sachet.ndma.gov.in'
      ? /^\/cap_public_website\/(rss\/rss_[a-z_]+\.xml|FetchXMLFile)$/.test(u.pathname)
      : u.hostname === 'severeweather.wmo.int' &&
        (/^\/f\/ows\/[A-Za-z0-9_.-]+\.json$/.test(u.pathname) ||
          u.pathname === '/json/sources.json' ||
          /^\/v2\/cap-alerts\/[A-Za-z0-9_./%-]+\.xml$/.test(u.pathname));
  if (!ok || target.length > 12_000) throw new Error('Unsupported warning source');
  return u;
}

function edgeCache(): Cache | undefined {
  return (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
}
function cacheKey(target: string): Request {
  return new Request(`https://stormsignal-cache.invalid/official-v1/${encodeURIComponent(target)}`);
}
function remember(key: string, value: TextResult) {
  memory.delete(key);
  memory.set(key, value);
  let bytes = [...memory.values()].reduce((n, v) => n + v.text.length * 2, 0);
  while (memory.size > MAX_ENTRIES || bytes > MAX_MEMORY_BYTES) {
    const oldest = memory.keys().next().value!;
    bytes -= memory.get(oldest)!.text.length * 2;
    memory.delete(oldest);
  }
}
export function clearWarningCache() {
  memory.clear();
  pending.clear();
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('Warning feed exceeds the size limit');
  }
  if (!response.body) throw new Error('Warning feed is empty');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0,
    text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error('Warning feed exceeds the size limit');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function retrieve(target: string, maxBytes: number, ttlMs: number): Promise<TextResult> {
  let old = memory.get(target);
  if (!old) {
    try {
      const hit = await edgeCache()?.match(cacheKey(target));
      if (hit) {
        const fetchedAt = Number(hit.headers.get('x-storm-fetched-at'));
        if (fetchedAt > 0 && fetchedAt <= Date.now() && Date.now() - fetchedAt < RETENTION) {
          old = {
            text: await boundedText(hit, maxBytes),
            fetchedAt,
            etag: hit.headers.get('etag') || undefined,
          };
          remember(target, old);
        }
      }
    } catch {
      /* Cache failure must not stop a fresh provider check. */
    }
  }
  if (old && Date.now() - old.fetchedAt < ttlMs) return old;
  const headers = new Headers({
    Accept: 'application/xml, application/json, text/xml;q=0.9',
    'User-Agent': 'StormSignal/1.0 (+https://github.com/TARUNTEjjjj/stormsignal)',
  });
  if (old?.etag) headers.set('If-None-Match', old.etag);
  // The provider timeout bounds stalled downloads as well as response headers.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    // Cloudflare supports follow/manual only. Reject 3xx below without following.
    const response = await fetch(target, {
      headers,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status === 304 && (!old || !old.etag))
      throw new Error('Warning cache could not be revalidated');
    if (response.status !== 304 && !response.ok) {
      await response.body?.cancel();
      throw new Error(`Official warning source unavailable (HTTP ${response.status})`);
    }
    const result: TextResult = {
      text: response.status === 304 ? old!.text : await boundedText(response, maxBytes),
      fetchedAt: Date.now(),
      etag: response.headers.get('etag') || (response.status === 304 ? old?.etag : undefined),
    };
    remember(target, result);
    try {
      const h = new Headers({
        'Cache-Control': 'public, max-age=86400',
        'Content-Type': 'text/plain; charset=utf-8',
        'x-storm-fetched-at': String(result.fetchedAt),
      });
      if (result.etag) h.set('etag', result.etag);
      await edgeCache()?.put(cacheKey(target), new Response(result.text, { headers: h }));
    } catch {
      /* Successful reads remain usable when the optional cache fails. */
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestText(target: string, options: TextOptions = {}): Promise<TextResult> {
  allowed(target);
  options.signal?.throwIfAborted();
  if (
    (options.maxBytes !== undefined &&
      (!Number.isFinite(options.maxBytes) || options.maxBytes < 1)) ||
    (options.ttlMs !== undefined && !Number.isFinite(options.ttlMs))
  )
    throw new Error('Invalid warning request limits');
  const maxBytes = Math.min(options.maxBytes ?? 2_000_000, 4_000_000);
  const ttlMs = Math.min(Math.max(options.ttlMs ?? 60_000, 0), 24 * 60 * 60_000);
  let task = pending.get(target);
  if (!task) {
    if (pending.size >= 32)
      throw new Error('Warning service busy; retry shortly or check the official source');
    task = retrieve(target, maxBytes, ttlMs);
    pending.set(target, task);
    task
      .finally(() => {
        if (pending.get(target) === task) pending.delete(target);
      })
      .catch(() => {});
  }
  // A caller can stop waiting without cancelling a public response shared with others.
  const signal = options.signal;
  let removeAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbort = () => signal.removeEventListener('abort', onAbort);
    }
  });
  let result: TextResult;
  try {
    result = await Promise.race([task, aborted]);
  } finally {
    removeAbort();
  }
  options.signal?.throwIfAborted();
  if (new TextEncoder().encode(result.text).byteLength > maxBytes)
    throw new Error('Warning feed exceeds the size limit');
  return result;
}
