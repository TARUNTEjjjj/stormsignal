import { readFile, readdir, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { writeWorkerLicenses } from './worker-licenses.mjs';
await writeWorkerLicenses();
// Build a self-contained Worker for local preview and release verification.
// Assets are embedded so this build requires no additional storage binding.
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.md': 'text/markdown; charset=utf-8',
};
const assets = {};
async function collect(dir = '') {
  for (const entry of await readdir(`dist/${dir}`, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_') || entry.name === 'server')
      continue;
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) await collect(`${path}/`);
    else {
      const bytes = await readFile(`dist/${path}`);
      const extension = path.slice(path.lastIndexOf('.'));
      if (!types[extension]) throw new Error(`Unhandled static asset ${path}`);
      assets[`/${path}`] = {
        body: bytes.toString('base64'),
        type: types[extension],
        etag: `"${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}"`,
      };
    }
  }
}
await collect();
if (!assets['/index.html'] || !assets['/sw.js'] || !assets['/offline.html'])
  throw new Error('Missing required application assets');
await mkdir('dist/server', { recursive: true });
await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist/server/index.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  minify: true,
  plugins: [
    {
      name: 'embedded-assets',
      setup(b) {
        b.onResolve({ filter: /^stormsignal:assets$/ }, () => ({
          path: 'assets',
          namespace: 'embedded',
        }));
        b.onLoad({ filter: /.*/, namespace: 'embedded' }, () => ({
          contents: JSON.stringify(assets),
          loader: 'json',
        }));
      },
    },
  ],
});
console.log(`Worker built with ${Object.keys(assets).length} embedded static assets.`);
