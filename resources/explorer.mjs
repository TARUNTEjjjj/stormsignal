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
  if (value?.schemaVersion !== 1 || !Array.isArray(value.items) || !Array.isArray(value.categories)) throw new Error('Unsupported collection');
  const categories = value.categories.slice(0, 100).filter(c => typeof c?.id === 'string' && typeof c.title === 'string').map(c => ({id: text(c.id, 100), title: text(c.title, 120)}));
  const known = new Set(categories.map(c => c.id));
  const items = value.items.slice(0, 2000).filter(item => safeRepositoryUrl(item) && known.has(item.category)).map(item => ({
    ...item, description: text(item.description), reason: text(item.reason, 240),
    topics: Array.isArray(item.topics) ? item.topics.filter(t => typeof t === 'string').slice(0, 6).map(t => text(t, 60)) : [],
    stars: Number.isSafeInteger(item.stars) && item.stars >= 0 ? item.stars : null,
    score: Number.isFinite(item.score) ? item.score : 0,
    license: text(item.license, 80), fetchedAt: dateValue(item.fetchedAt) === null ? null : item.fetchedAt,
    pushedAt: dateValue(item.pushedAt) === null ? null : item.pushedAt,
  }));
  return {...value, title: text(value.title, 120), project: text(value.project, 100), categories, items};
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

export function statusSummary(catalog) {
  const date = observedDate(catalog.fetchedAt);
  if (catalog.status === 'seed') return 'Starter collection · live metadata has not been verified yet.';
  if (catalog.status === 'partial') return `Published snapshot · refresh partly unavailable. Individual observations may be older. Last refresh: ${date} (UTC).`;
  return `Published snapshot · last collection refresh: ${date} (UTC). See each card for its observation date.`;
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
  let catalog;
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
      const response = await fetch(new URL('./catalog.json', import.meta.url), {cache: 'no-cache', credentials: 'omit', signal: AbortSignal.timeout(10000)});
      if (!response.ok) throw new Error('Collection unavailable');
      catalog = normalizeCatalog(await response.json());
      document.title = `${catalog.title || catalog.project || 'Project'} · Resource library`;
      byId('project-name').textContent = catalog.title || catalog.project || 'Resource library';
      byId('total-count').textContent = String(catalog.items.length);
      byId('category-count').textContent = String(catalog.categories.length);
      byId('freshness').textContent = statusSummary(catalog);
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
