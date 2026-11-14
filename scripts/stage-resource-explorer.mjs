import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

// Only these reviewed public files are served. Configuration and response caches
// stay outside the published directory.
export const publicResourceFiles = ['index.html', 'explorer.css', 'explorer.mjs', 'catalog.json',
  'catalog.mjs', 'storage.mjs', 'live.mjs', 'background.mjs', 'offline.mjs', 'offline-worker.js'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function renderResourceWorker(inputs) {
  const catalog = JSON.parse(inputs.get('catalog.json'));
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.items)) throw new Error('Invalid resource catalog');
  const template = inputs.get('offline-worker.js').toString('utf8');
  if (!template.includes('/* RESOURCE_SHELL_MANIFEST */ []')) throw new Error('Missing resource worker template');
  const manifest = publicResourceFiles.filter(file => file !== 'offline-worker.js').map(file => file === 'catalog.json'
    ? {file, bytes: null, sha256: null}
    : {file, bytes: inputs.get(file).length, sha256: digest(inputs.get(file))});
  // Catalog refreshes change data without producing a new application-code release.
  const version = digest(JSON.stringify({manifest, template})).slice(0, 24);
  return Buffer.from(template.replace("/* RESOURCE_SHELL_VERSION */ 'development'", JSON.stringify(version))
    .replace("/* RESOURCE_PROJECT */ ''", JSON.stringify(catalog.project ?? ''))
    .replace('/* RESOURCE_SHELL_MANIFEST */ []', JSON.stringify(manifest)));
}

export async function readResourceExplorerInputs(root) {
  const inputs = new Map(await Promise.all(publicResourceFiles.map(async file => [file, await readFile(resolve(root, 'resources', file))])));
  inputs.set('offline-worker.js', renderResourceWorker(inputs));
  return inputs;
}

export async function stageResourceExplorer(root, output) {
  const inputs = await readResourceExplorerInputs(root);
  await mkdir(output, {recursive: true});
  for (const [file, bytes] of inputs) await writeFile(resolve(output, file), bytes);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const target = process.argv[2];
  if (!['public/resources', 'dist/resources'].includes(target)) throw new Error('Choose public/resources or dist/resources');
  await stageResourceExplorer(root, resolve(root, target));
}
