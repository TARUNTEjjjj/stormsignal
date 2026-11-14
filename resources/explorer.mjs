import {PROJECT, normalizeCatalog, safeRepositoryUrl, dateValue, loadCatalog} from './catalog.mjs';
import {createCatalogController, bindCatalogLifecycle} from './live.mjs';
import {ensureOfflineShell} from './offline.mjs';
import {startAppUpdates} from './app-updates.mjs';
export {PROJECT, LIVE_CATALOG_URL, normalizeCatalog, safeRepositoryUrl, loadCatalog} from './catalog.mjs';

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
  const origin = source === 'github' ? 'GitHub snapshot · automatically updated at the source.' : source === 'saved' ? 'Saved snapshot · restored from this browser.' : 'Bundled snapshot · included with this app.';
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
  startAppUpdates();
  const byId = id => document.getElementById(id);
  const search = byId('search'), category = byId('category'), sort = byId('sort');
  let catalog, catalogText, downloadUrl, shell = {available: false, pending: true}, latestState;
  function render() {
    if (!catalog) return;
    const items = filterItems(catalog.items, {query: search.value, category: category.value, sort: sort.value});
    const names = new Map(catalog.categories.map(c => [c.id, c.title]));
    byId('resource-grid').replaceChildren(...items.map(item => card(item, names)));
    byId('result-count').textContent = `${items.length} of ${catalog.items.length} resources`;
    byId('empty-state').hidden = items.length > 0;
  }
  const timeLabel = value => value === null ? 'Not yet in this tab' : new Date(value).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
  function status(state) {
    byId('refresh').textContent = state.refreshing ? 'Refreshing…' : 'Refresh now';
    byId('refresh').setAttribute('aria-busy', String(state.refreshing));
    byId('last-checked').textContent = `Last successful check: ${timeLabel(state.lastSuccessfulCheck)}`;
    byId('next-check').textContent = state.refreshing ? 'Next check: after this request completes' : state.nextCheckAt === null ? 'Checks every 15 minutes while this app is open' : `Next check: ${timeLabel(state.nextCheckAt)}`;
    byId('refresh-status').textContent = state.refreshing ? 'Checking the published GitHub collection…' : state.error || (state.retainedNewer ? 'The downloaded copy was older. Your newer collection is kept.' : 'Automatic checks are on. Search and sorting stay as you leave them.');
    const saved = state.savedOffline ? 'Saved offline snapshot' : state.storageError ? 'Offline saving unavailable in this browser' : 'This collection has not been saved in this browser';
    const page = shell.pending ? 'preparing the offline library…' : shell.available ? 'offline library ready' : 'offline page unavailable';
    byId('offline-status').textContent = `${saved} · ${page}.`;
    byId('load-error').hidden = !!state.catalog || state.refreshing;
    if (!state.catalog) byId('freshness').textContent = state.refreshing ? 'Loading the published collection…' : 'Collection unavailable. Reconnect and use Refresh now.';
  }
  function update(state) {
    latestState = state;
    status(state);
    if (!state.catalog) return;
    byId('freshness').textContent = statusSummary(state.catalog, state.source);
    const nextText = JSON.stringify(state.catalog);
    if (nextText === catalogText) return;
    const position = {left: window.scrollX, top: window.scrollY};
    const focusedLink = document.activeElement?.closest?.('.resource-card a')?.href;
    catalog = state.catalog; catalogText = nextText;
    document.title = `${catalog.title || catalog.project || 'Project'} · Resource library`;
    byId('project-name').textContent = catalog.title || catalog.project || 'Resource library';
    byId('total-count').textContent = String(catalog.items.length);
    byId('category-count').textContent = String(catalog.categories.length);
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(catalog, null, 2) + '\n'], {type: 'application/json'}));
    const download = document.querySelector('.download-link');
    download.href = downloadUrl; download.download = `${PROJECT}-resources.json`;
    const chosen = category.value;
    category.replaceChildren(element('option', '', 'All areas'));
    category.options[0].value = '';
    for (const area of catalog.categories) {
      const option = element('option', '', area.title); option.value = area.id; category.append(option);
    }
    if (chosen && !catalog.categories.some(area => area.id === chosen)) {
      const option = element('option', '', `${chosen} (no longer in this collection)`); option.value = chosen; category.append(option);
    }
    category.value = chosen;
    render();
    if (focusedLink) [...byId('resource-grid').querySelectorAll('a')].find(link => link.href === focusedLink)?.focus({preventScroll: true});
    window.scrollTo(position);
  }
  const controller = createCatalogController({onChange: update});
  bindCatalogLifecycle(controller);
  byId('filters').addEventListener('submit', event => event.preventDefault());
  search.addEventListener('input', render); category.addEventListener('change', render); sort.addEventListener('change', render);
  byId('reset-filters').addEventListener('click', () => { search.value = ''; category.value = ''; sort.value = 'recommended'; render(); search.focus(); });
  byId('retry').addEventListener('click', () => { void controller.refresh(); });
  byId('refresh').addEventListener('click', () => { void controller.refresh(); });
  void ensureOfflineShell().then(result => { shell = result; if (latestState) status(latestState); }, () => { shell = {available: false}; if (latestState) status(latestState); });
  await controller.start();
  return controller;
}

if (typeof document !== 'undefined' && document.getElementById('resource-grid')) void startExplorer();
