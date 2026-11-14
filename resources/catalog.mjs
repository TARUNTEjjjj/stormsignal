// Replaced with a repository-specific literal when copied into each project.
export const PROJECT = 'stormsignal';
export const LIVE_CATALOG_URL = `https://raw.githubusercontent.com/TARUNTEjjjj/${PROJECT}/main/resources/catalog.json`;
export const MAX_CATALOG_BYTES = 1024 * 1024;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const dateValue = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const text = (value, max = 500) => typeof value === 'string' ? value.slice(0, max) : '';

export function safeRepositoryUrl(item) {
  if (!REPOSITORY.test(item?.fullName ?? '')) return null;
  try {
    const url = new URL(item.url);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname.toLowerCase() === `/${item.fullName}`.toLowerCase() ? url.href : null;
  } catch { return null; }
}

export function normalizeCatalog(value) {
  if (value?.schemaVersion !== 1 || value.project !== PROJECT || !Array.isArray(value.items) || !Array.isArray(value.categories) || value.items.length > 2000 || value.categories.length > 100 || !['live', 'cached', 'seed', 'partial'].includes(value.status)) throw new Error('Unsupported collection or project');
  if (value.categories.some(c => !c || typeof c.id !== 'string' || !c.id || typeof c.title !== 'string' || !c.title)) throw new Error('Invalid collection areas');
  const categories = value.categories.map(c => ({id: text(c.id, 100), title: text(c.title, 120), count: value.items.filter(item => item?.category === c.id).length}));
  const known = new Set(categories.map(c => c.id));
  if (known.size !== categories.length || value.items.some(item => !safeRepositoryUrl(item) || !known.has(item.category))) throw new Error('Invalid repository link or area');
  const items = value.items.map(item => ({
    id: Number.isSafeInteger(item.id) ? item.id : text(item.id, 200) || item.fullName, fullName: item.fullName, url: safeRepositoryUrl(item), category: item.category,
    description: text(item.description), reason: text(item.reason, 240),
    topics: Array.isArray(item.topics) ? item.topics.filter(t => typeof t === 'string').slice(0, 6).map(t => text(t, 60)) : [],
    stars: Number.isSafeInteger(item.stars) && item.stars >= 0 ? item.stars : null,
    forks: Number.isSafeInteger(item.forks) && item.forks >= 0 ? item.forks : null,
    score: Number.isFinite(item.score) ? item.score : 0,
    license: text(item.license, 80), fetchedAt: dateValue(item.fetchedAt) === null ? null : item.fetchedAt,
    pushedAt: dateValue(item.pushedAt) === null ? null : item.pushedAt,
    sourceQuery: text(item.sourceQuery, 300), provenance: item.provenance === 'github' ? 'github' : 'seed', stale: item.stale === true,
  }));
  return {schemaVersion: 1, project: PROJECT, title: text(value.title, 120),
    fetchedAt: dateValue(value.fetchedAt) === null ? null : value.fetchedAt,
    attemptedAt: dateValue(value.attemptedAt) === null ? null : value.attemptedAt,
    status: value.status, categories, items,
    errors: Array.isArray(value.errors) ? value.errors.slice(0, 160).map(error => ({source: text(error?.source, 300), message: text(error?.message, 300)})) : [],
    excludedSeeds: Array.isArray(value.excludedSeeds) ? value.excludedSeeds.filter(seed => REPOSITORY.test(seed?.fullName ?? '') && known.has(seed.category)).slice(0, 2000).map(({fullName, category}) => ({fullName, category})) : [],
  };
}

async function readSnapshot(url, {fetchImpl, timeoutMs, maxBytes, signal}) {
  const controller = new AbortController();
  let response, reader, timer, rejectAbort;
  const abort = () => { controller.abort(); cancel(); rejectAbort?.(new Error('Snapshot request cancelled')); };
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  signal?.addEventListener('abort', abort, {once: true});
  const cancel = () => {
    try { reader?.cancel().catch(() => {}); } catch {}
    try { response?.body?.cancel().catch(() => {}); } catch {}
  };
  const transfer = (async () => {
    if (signal?.aborted) throw new Error('Snapshot request cancelled');
    response = await fetchImpl(url, {method: 'GET', mode: 'cors', cache: 'no-cache', credentials: 'omit', redirect: 'error', headers: {Accept: 'application/json'}, signal: controller.signal});
    controller.signal.throwIfAborted();
    if (!response.ok || response.redirected || !response.body) throw new Error('Snapshot unavailable');
    const declared = Number(response.headers.get('Content-Length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Snapshot exceeds byte limit');
    reader = response.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const {value, done} = await reader.read();
      controller.signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Snapshot exceeds byte limit');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return normalizeCatalog(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)));
  })().catch(error => { cancel(); throw error; });
  try {
    return await Promise.race([transfer, aborted, new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); cancel(); reject(new Error('Snapshot request timed out')); }, timeoutMs);
    })]);
  } finally {
    signal?.removeEventListener('abort', abort);
    clearTimeout(timer); controller.abort(); cancel();
    try { reader?.releaseLock(); } catch {}
  }
}

export async function loadCatalog({fetchImpl = globalThis.fetch, remoteTimeoutMs = 6000, localTimeoutMs = 4000, maxBytes = MAX_CATALOG_BYTES} = {}) {
  if (![remoteTimeoutMs, localTimeoutMs, maxBytes].every(value => Number.isSafeInteger(value) && value > 0) || remoteTimeoutMs > 10000 || localTimeoutMs > 10000 || maxBytes > MAX_CATALOG_BYTES) throw new Error('Invalid collection request limits');
  try {
    return {catalog: await readSnapshot(LIVE_CATALOG_URL, {fetchImpl, timeoutMs: remoteTimeoutMs, maxBytes}), source: 'github'};
  } catch {
    // Only the shipped same-origin snapshot is a fallback; callers cannot select
    // another host or inject a GitHub query through the search controls.
    return {catalog: await readSnapshot(new URL('./catalog.json', import.meta.url), {fetchImpl, timeoutMs: localTimeoutMs, maxBytes}), source: 'bundled'};
  }
}


function requestOptions(options, fallbackTimeout) {
  const {fetchImpl = globalThis.fetch, timeoutMs = fallbackTimeout, maxBytes = MAX_CATALOG_BYTES, signal} = options;
  if (![timeoutMs, maxBytes].every(value => Number.isSafeInteger(value) && value > 0) || timeoutMs > 10000 || maxBytes > MAX_CATALOG_BYTES) throw new Error('Invalid collection request limits');
  return {fetchImpl, timeoutMs, maxBytes, signal};
}
export function loadRemoteCatalog(options = {}) {
  return readSnapshot(LIVE_CATALOG_URL, requestOptions(options, 6000));
}
export function loadBundledCatalog(options = {}) {
  return readSnapshot(new URL('./catalog.json', import.meta.url), requestOptions(options, 4000));
}
export function catalogDate(catalog) { return dateValue(catalog?.fetchedAt); }
export function isOlderCatalog(candidate, current) {
  if (!current) return false;
  const incoming = catalogDate(candidate) ?? -Infinity, existing = catalogDate(current) ?? -Infinity;
  if (incoming !== existing) return incoming < existing;
  return (dateValue(candidate?.attemptedAt) ?? -Infinity) < (dateValue(current?.attemptedAt) ?? -Infinity);
}
export function catalogJSON(catalog) {
  const normalized = normalizeCatalog(catalog);
  const json = JSON.stringify(normalized);
  if (new TextEncoder().encode(json).byteLength > MAX_CATALOG_BYTES) throw new Error('Snapshot exceeds byte limit');
  return json;
}
