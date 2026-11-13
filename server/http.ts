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
const CACHE_TIMEOUT_MS = 200;
const PROVIDER_TIMEOUT_MS = 8_000;
const RETRY_DELAY_MS = 150;
const RETRY_STATUS = new Set([408, 500, 502, 503, 504]);

function allowed(target: string): URL {
  if (target.split('?')[0].includes('\\') || /%(?:2f|5c|2e|25)/i.test(target.split('?')[0]))
    throw new Error('Unsupported warning source');
  const u = new URL(target);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash)
    throw new Error('Unsupported warning source');
  const ok =
    u.hostname === 'sachet.ndma.gov.in'
      ? /^\/cap_public_website\/(rss\/rss_[a-z_]+\.xml|FetchXMLFile)$/.test(u.pathname)
      : u.hostname === 'publicalert.pagasa.dost.gov.ph'
        ? !u.search &&
          (u.pathname === '/feeds/' ||
            /^\/output\/(gfa|acp|wcp)\/[a-f0-9-]{36}\.cap$/i.test(u.pathname))
        : u.hostname === 'www.bmkg.go.id'
          ? !u.search && /^\/alerts\/nowcast\/en(?:\/[A-Z0-9]{3,40}_alert\.xml)?$/.test(u.pathname)
          : u.hostname === 'mausam.imd.gov.in'
            ? !u.search && u.pathname === '/imd_latest/contents/dist_nowcast_rss.php'
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

/** Abort is a deadline, even when an optional cache or transport ignores its signal. */
async function interrupted<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let remove = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    remove = () => signal.removeEventListener('abort', stop);
  });
  try {
    return await Promise.race([task, aborted]);
  } finally {
    remove();
  }
}

async function deadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Official warning request timed out.', 'TimeoutError')),
    ms,
  );
  try {
    return await interrupted(run(controller.signal), controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

/** Cleanup is best-effort: an unread body's cancel implementation may itself stall. */
function cancel(body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array> | null) {
  try {
    void body?.cancel().catch(() => {});
  } catch {
    /* Already closed or locked elsewhere. */
  }
}

async function boundedText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  if (Number(response.headers.get('content-length')) > maxBytes) {
    cancel(response.body);
    throw new Error('Warning feed exceeds the size limit');
  }
  if (!response.body) throw new Error('Warning feed is empty');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0,
    text = '';
  try {
    for (;;) {
      const chunk = await interrupted(reader.read(), signal);
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error('Warning feed exceeds the size limit');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    cancel(reader);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function transientFetchError(error: unknown): boolean {
  if (error instanceof TypeError) return true; // Native fetch reports connection failures this way.
  if (!(error instanceof Error)) return false;
  const code =
    (error as Error & { code?: string; cause?: { code?: string } }).code ??
    (error as Error & { cause?: { code?: string } }).cause?.code;
  return (
    error.name === 'NetworkError' ||
    /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN)$/.test(code ?? '')
  );
}

function retryDelay(response: Response): number {
  const raw = response.headers.get('retry-after');
  if (!raw) return RETRY_DELAY_MS;
  if (/^\d+$/.test(raw.trim())) return Number(raw) * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : RETRY_DELAY_MS;
}

async function waitToRetry(ms: number, signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await interrupted(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function providerResponse(
  target: string,
  headers: Headers,
  signal: AbortSignal,
): Promise<Response> {
  const until = Date.now() + PROVIDER_TIMEOUT_MS;
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    let response: Response | undefined;
    let failure: unknown;
    let delay = RETRY_DELAY_MS;
    try {
      // Cancel a late response too; the explicit deadline may already have won the race.
      response = await interrupted(
        fetch(target, {
          headers,
          redirect: 'manual',
          signal,
        }).then((value) => {
          if (signal.aborted) cancel(value.body);
          return value;
        }),
        signal,
      );
    } catch (error) {
      if (signal.aborted || attempt > 0 || !transientFetchError(error)) throw error;
      failure = error;
    }
    if (response) {
      if (response.ok || response.status === 304) return response;
      cancel(response.body);
      failure = new Error(`Official warning source unavailable (HTTP ${response.status})`);
      if (attempt > 0 || !RETRY_STATUS.has(response.status)) throw failure;
      delay = retryDelay(response);
    }
    // Never retry early against Retry-After, nor extend the original request budget.
    if (!Number.isFinite(delay) || delay >= until - Date.now()) throw failure;
    await waitToRetry(delay, signal);
  }
}

async function retrieve(target: string, maxBytes: number, ttlMs: number): Promise<TextResult> {
  let old = memory.get(target);
  if (!old) {
    try {
      const hit = await deadline(CACHE_TIMEOUT_MS, async (signal) => {
        const cached = await interrupted(
          Promise.resolve(edgeCache()?.match(cacheKey(target))).then((value) => {
            if (signal.aborted && value) cancel(value.body);
            return value;
          }),
          signal,
        );
        if (!cached) return;
        const fetchedAt = Number(cached.headers.get('x-storm-fetched-at'));
        if (!(fetchedAt > 0 && fetchedAt <= Date.now() && Date.now() - fetchedAt < RETENTION)) {
          cancel(cached.body);
          return;
        }
        return {
          text: await boundedText(cached, maxBytes, signal),
          fetchedAt,
          etag: cached.headers.get('etag') || undefined,
        };
      });
      if (hit) {
        old = hit;
        remember(target, old);
      }
    } catch {
      /* A failed or stalled optional cache must not stop a fresh provider check. */
    }
  }
  if (old && Date.now() - old.fetchedAt < ttlMs) return old;
  const headers = new Headers({
    Accept: 'application/xml, application/json, text/xml;q=0.9',
    'User-Agent': 'StormSignal/1.0 (+https://github.com/TARUNTEjjjj/stormsignal)',
  });
  if (old?.etag) headers.set('If-None-Match', old.etag);
  // One total budget includes both attempts and response bodies, not just headers.
  const result = await deadline(PROVIDER_TIMEOUT_MS, async (signal) => {
    const response = await providerResponse(target, headers, signal);
    signal.throwIfAborted();
    if (response.status === 304 && (!old || !old.etag)) {
      cancel(response.body);
      throw new Error('Warning cache could not be revalidated');
    }
    return {
      text: response.status === 304 ? old!.text : await boundedText(response, maxBytes, signal),
      fetchedAt: Date.now(),
      etag: response.headers.get('etag') || (response.status === 304 ? old?.etag : undefined),
    };
  });
  remember(target, result);
  try {
    const h = new Headers({
      'Cache-Control': 'public, max-age=86400',
      'Content-Type': 'text/plain; charset=utf-8',
      'x-storm-fetched-at': String(result.fetchedAt),
    });
    if (result.etag) h.set('etag', result.etag);
    await deadline(CACHE_TIMEOUT_MS, async (signal) =>
      interrupted(
        Promise.resolve(
          edgeCache()?.put(cacheKey(target), new Response(result.text, { headers: h })),
        ),
        signal,
      ),
    );
  } catch {
    /* Successful reads remain usable when the optional cache fails or stalls. */
  }
  return result;
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
