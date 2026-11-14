import {readFile, readdir, lstat, mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, relative, sep, isAbsolute} from 'node:path';

const META = /<meta\s+[^>]*name=["']app-(?:version|project)["'][^>]*>\s*/gi;
const validProject = project => typeof project === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(project);
const excluded = path => path === 'resources/catalog.json' || /(?:^|\/)app-version\.json$|\.cache\.json$/.test(path);
const validPath = path => typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.includes('\\') && !path.split('/').some(part => !part || part === '.' || part === '..');
function validateRelease(release) {
  if (release?.schemaVersion !== 1 || !validProject(release.project) || !/^[a-f0-9]{64}$/.test(release.version)) throw new Error('Invalid app release');
}
export function stampAppVersion(html, release) {
  validateRelease(release);
  const clean = html.replace(META, '');
  if (!/<\/head>/i.test(clean)) throw new Error('App HTML has no head');
  return clean.replace(/<\/head>/i, `<meta name="app-version" content="${release.version}"><meta name="app-project" content="${release.project}"></head>`);
}
export function createAppRelease({project, sources}) {
  if (!validProject(project) || !Array.isArray(sources) || !sources.length) throw new Error('Invalid app release inputs');
  const paths = new Set();
  for (const entry of sources) {
    if (!validPath(entry?.path) || paths.has(entry.path) || !(typeof entry.bytes === 'string' || entry.bytes instanceof Uint8Array)) throw new Error('Invalid or duplicate app source');
    paths.add(entry.path);
  }
  const inputs = sources.filter(entry => !excluded(entry.path)).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!inputs.length) throw new Error('No application code inputs');
  // Content identity stays reproducible across commits and machines. Catalog
  // metadata refreshes and previously stamped HTML never create a reload loop.
  const hash = createHash('sha256').update(`app-release-v1\0${project}\0`);
  for (const entry of inputs) {
    let bytes = Buffer.from(entry.bytes);
    if (/\.html$/i.test(entry.path)) bytes = Buffer.from(bytes.toString('utf8').replace(META, ''));
    hash.update(entry.path).update('\0').update(bytes).update('\0');
  }
  return {schemaVersion: 1, project, version: hash.digest('hex')};
}
export async function readAppRelease(root, {project, sourcePaths, ignorePaths = []} = {}) {
  if (!Array.isArray(sourcePaths) || !sourcePaths.length || !sourcePaths.every(validPath) || !Array.isArray(ignorePaths) || !ignorePaths.every(validPath)) throw new Error('Explicit relative source paths are required');
  root = resolve(root);
  const paths = new Set(), ignored = new Set(ignorePaths);
  async function visit(path) {
    const absolute = resolve(root,path), name = relative(root,absolute).split(sep).join('/');
    if (!validPath(name)) throw new Error('App source escaped project root');
    if ([...ignored].some(prefix => name === prefix || name.startsWith(prefix+'/')) || excluded(name) || name.split('/').some(part=>['node_modules','.git','.wrangler'].includes(part))) return;
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error('App release sources must not be symbolic links');
    if (info.isDirectory()) for (const entry of (await readdir(absolute)).sort()) await visit(name+'/'+entry);
    else if (info.isFile()) paths.add(name);
    else throw new Error('Unsupported app release source');
  }
  for (const path of sourcePaths) await visit(path);
  const sources = await Promise.all([...paths].map(async path=>({path,bytes:await readFile(resolve(root,path))})));
  return createAppRelease({project,sources});
}
export async function writeAppVersion(outputRoot, release, {workers = []} = {}) {
  validateRelease(release);
  const scopes = new Set();
  for (const worker of workers) {
    if (!['/', '/resources/'].includes(worker.scope) || typeof worker.script !== 'string' || !/^\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.js$/.test(worker.script) || worker.script.includes('..') || scopes.has(worker.scope)) throw new Error('Invalid app worker');
    scopes.add(worker.scope);
  }
  await mkdir(outputRoot,{recursive:true});
  const value = {...release,workers:workers.map(({scope,script})=>({scope,script,version:release.version}))};
  await writeFile(resolve(outputRoot,'app-version.json'),JSON.stringify(value,null,2)+'\n');
  return value;
}
