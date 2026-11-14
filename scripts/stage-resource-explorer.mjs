import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stampAppVersion} from './app-release.mjs';
import {workerUpdateProtocolSource} from './app-update-protocol.mjs';

// Only these reviewed public files are served. Configuration and response caches
// stay outside the published directory.
export const publicResourceFiles = ['index.html', 'explorer.css', 'explorer.mjs', 'catalog.json',
  'catalog.mjs', 'storage.mjs', 'live.mjs', 'background.mjs', 'offline.mjs', 'app-updates.mjs', 'offline-worker.js'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function renderResourceWorker(inputs, {release} = {}) {
  const catalog = JSON.parse(inputs.get('catalog.json'));
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.items)) throw new Error('Invalid resource catalog');
  const template = inputs.get('offline-worker.js').toString('utf8');
  if (!template.includes('/* RESOURCE_SHELL_MANIFEST */ []')) throw new Error('Missing resource worker template');
  const manifest = publicResourceFiles.filter(file => file !== 'offline-worker.js').map(file => file === 'catalog.json'
    ? {file, bytes: null, sha256: null}
    : {file, bytes: inputs.get(file).length, sha256: digest(inputs.get(file))});
  // Catalog refreshes change data without producing a new application-code release.
  const version = digest(JSON.stringify({manifest, template,appVersion:release?.version})).slice(0, 24);
  return Buffer.from(template.replace("/* RESOURCE_SHELL_VERSION */ 'development'", JSON.stringify(version))
    .replace("/* APP_VERSION */ 'development'", JSON.stringify(release?.version ?? 'development'))
    .replace('/* APP_UPDATE_PROTOCOL */',workerUpdateProtocolSource({readyExpression:'shellReady()'}))
    .replace("/* RESOURCE_PROJECT */ ''", JSON.stringify(catalog.project ?? ''))
    .replace('/* RESOURCE_SHELL_MANIFEST */ []', JSON.stringify(manifest)));
}

export async function readResourceExplorerInputs(root, {release} = {}) {
  const inputs = new Map(await Promise.all(publicResourceFiles.map(async file => [file, await readFile(resolve(root, 'resources', file))])));
  if (release) inputs.set('index.html',Buffer.from(stampAppVersion(inputs.get('index.html').toString('utf8'),release)));
  inputs.set('offline-worker.js', renderResourceWorker(inputs,{release}));
  return inputs;
}

export async function stageResourceExplorer(root, output, {release} = {}) {
  const inputs = await readResourceExplorerInputs(root,{release});
  await mkdir(output, {recursive: true});
  for (const [file, bytes] of inputs) await writeFile(resolve(output, file), bytes);
}
export async function stageRootOfflineWorker(root, outputRoot, {release} = {}) {
  const worker = await readFile(resolve(root, 'offline-resources-worker.js'));
  await mkdir(outputRoot, {recursive: true});
  const rendered = release ? worker.toString('utf8').replace("/* APP_VERSION */ 'development'",JSON.stringify(release.version))
    .replace('/* APP_UPDATE_PROTOCOL */',workerUpdateProtocolSource()) : worker;
  await writeFile(resolve(outputRoot, 'offline-resources-worker.js'), rendered);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const target = process.argv[2];
  if (!['public/resources', 'dist/resources'].includes(target)) throw new Error('Choose public/resources or dist/resources');
  await stageResourceExplorer(root, resolve(root, target));
  try { await stageRootOfflineWorker(root, resolve(root, dirname(target))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
