// Replaced with a repository-specific literal when copied into each project.
export const PROJECT = 'stormsignal';
export const LIVE_CATALOG_URL = `https://raw.githubusercontent.com/TARUNTEjjjj/${PROJECT}/main/resources/catalog.json`;
const MAX_CATALOG_BYTES = 1024 * 1024;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const dateValue = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
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
    id: item.id, fullName: item.fullName, url: safeRepositoryUrl(item), category: item.category,
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

async function readSnapshot(url, {fetchImpl, timeoutMs, maxBytes}) {
  const controller = new AbortController();
  let response, reader, timer;
  const cancel = () => {
    try { reader?.cancel().catch(() => {}); } catch {}
    try { response?.body?.cancel().catch(() => {}); } catch {}
  };
  const transfer = (async () => {
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
    return await Promise.race([transfer, new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); cancel(); reject(new Error('Snapshot request timed out')); }, timeoutMs);
    })]);
  } finally {
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

export function filterItems(items, {query = '', category = '', sort = 'recommended'} = {}) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter(item => (!category || item.category === category) && terms.every(term => `${item.fullName} ${item.description} ${item.topics.join(' ')}`.toLowerCase().includes(term))).sort((a, b) => {
    let difference = 0;
    if (sort === 'stars') difference = (b.stars ?? -1) - (a.stars ?? -1);
    else if (sort === 'recent') difference = (dateValue(b.pushedAt) ?? 0) - (dateValue(a.pushedAt) ?? 0);
    else difference = b.score - a.score;
    return difference || a.fullName.localeCompare(b.fullName, 'en');
  });
}

export function observedDate(value) {
  const parsed = dateValue(value);
  return parsed === null ? 'not yet verified' : new Date(parsed).toISOString().slice(0, 10);
}

export function statusSummary(catalog, source = 'bundled') {
  const date = observedDate(catalog.fetchedAt);
  const origin = source === 'github' ? 'GitHub snapshot · automatically updated at the source.' : 'Bundled snapshot · GitHub could not be reached or verified.';
  if (catalog.status === 'seed') return `${origin} Starter collection; live metadata has not been verified yet.`;
  if (catalog.status === 'partial') return `${origin} Refresh partly unavailable; individual observations may be older. Last successful metadata: ${date} (UTC).`;
  return `${origin} Last metadata refresh: ${date} (UTC). See each card for its observation date.`;
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function card(item, categories) {
  const article = element('article', 'resource-card');
  const top = element('div', 'card-top');
  top.append(element('span', 'category-tag', categories.get(item.category) || item.category));
  const stars = item.stars === null ? 'Stars unverified' : `☆ ${new Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1}).format(item.stars)}`;
  const starNode = element('span', 'star-count', stars);
  if (item.stars !== null) starNode.title = `${new Intl.NumberFormat('en').format(item.stars)} GitHub stars at observation time`;
  top.append(starNode);
  const heading = element('h3');
  const [owner, name] = item.fullName.split('/');
  heading.append(element('span', 'repo-owner', owner));
  const link = element('a', '', `${name} ↗`);
  link.href = safeRepositoryUrl(item); link.target = '_blank'; link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', `${item.fullName} on GitHub (opens a new tab)`);
  heading.append(link);
  article.append(top, heading, element('p', 'card-description', item.description || 'Explore this repository’s documentation and examples on GitHub.'));
  const topics = element('ul', 'topics');
  topics.setAttribute('aria-label', 'Topics');
  for (const topic of item.topics) topics.append(element('li', '', topic));
  if (topics.childElementCount) article.append(topics);
  const bottom = element('div', 'card-bottom');
  if (item.reason) bottom.append(element('p', 'card-reason', item.reason));
  bottom.append(element('p', 'card-meta', `License: ${item.license || 'not identified'} · Last push: ${observedDate(item.pushedAt)}`));
  bottom.append(element('p', item.stale ? 'card-meta stale-tag' : 'card-meta', `${item.stale ? 'Cached observation' : 'Observed'}: ${observedDate(item.fetchedAt)}${item.fetchedAt ? ' (UTC)' : ''}`));
  article.append(bottom);
  return article;
}

export async function startExplorer() {
  const byId = id => document.getElementById(id);
  const search = byId('search'), category = byId('category'), sort = byId('sort');
  let catalog, downloadUrl;
  function render() {
    if (!catalog) return;
    const items = filterItems(catalog.items, {query: search.value, category: category.value, sort: sort.value});
    const names = new Map(catalog.categories.map(c => [c.id, c.title]));
    byId('resource-grid').replaceChildren(...items.map(item => card(item, names)));
    byId('result-count').textContent = `${items.length} of ${catalog.items.length} resources`;
    byId('empty-state').hidden = items.length > 0;
  }
  async function load() {
    byId('load-error').hidden = true; byId('empty-state').hidden = true;
    byId('retry').disabled = true;
    byId('freshness').textContent = 'Loading the published collection…';
    try {
      const loaded = await loadCatalog();
      catalog = loaded.catalog;
      document.title = `${catalog.title || catalog.project || 'Project'} · Resource library`;
      byId('project-name').textContent = catalog.title || catalog.project || 'Resource library';
      byId('total-count').textContent = String(catalog.items.length);
      byId('category-count').textContent = String(catalog.categories.length);
      byId('freshness').textContent = statusSummary(catalog, loaded.source);
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(catalog, null, 2) + '\n'], {type: 'application/json'}));
      const download = document.querySelector('.download-link');
      download.href = downloadUrl; download.download = `${PROJECT}-resources.json`;
      category.replaceChildren(element('option', '', 'All areas'));
      category.options[0].value = '';
      for (const area of catalog.categories) {
        const option = element('option', '', area.title); option.value = area.id; category.append(option);
      }
      render();
    } catch {
      byId('freshness').textContent = 'Collection unavailable. Try reloading when you are online.';
      byId('load-error').hidden = false;
    } finally { byId('retry').disabled = false; }
  }
  byId('filters').addEventListener('submit', event => event.preventDefault());
  search.addEventListener('input', render); category.addEventListener('change', render); sort.addEventListener('change', render);
  byId('reset-filters').addEventListener('click', () => { search.value = ''; category.value = ''; sort.value = 'recommended'; render(); search.focus(); });
  byId('retry').addEventListener('click', load);
  await load();
}

if (typeof document !== 'undefined') startExplorer();
