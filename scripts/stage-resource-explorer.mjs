import {mkdir, copyFile, readFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

// Only these reviewed public files are served. Configuration and response caches
// stay outside the published directory.
export const publicResourceFiles = ['index.html', 'explorer.css', 'explorer.mjs', 'catalog.json'];
export async function stageResourceExplorer(root, output) {
  const inputs = await Promise.all(publicResourceFiles.map(file => readFile(resolve(root, 'resources', file))));
  const catalog = JSON.parse(inputs[3]);
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.items)) throw new Error('Invalid resource catalog');
  await mkdir(output, {recursive: true});
  for (const file of publicResourceFiles) await copyFile(resolve(root, 'resources', file), resolve(output, file));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const target = process.argv[2];
  if (!['public/resources', 'dist/resources'].includes(target)) throw new Error('Choose public/resources or dist/resources');
  await stageResourceExplorer(root, resolve(root, target));
}
