import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

// This directory contains public assets only. Preview bundles and build metadata
// stay in dist/ and are never uploaded to Pages.
const output = 'pages-dist';
await rm(output, { recursive: true, force: true });
await mkdir(output);
for (const entry of await readdir('dist', { withFileTypes: true })) {
  if (entry.name.startsWith('.') || entry.name === 'server') continue;
  await cp(`dist/${entry.name}`, `${output}/${entry.name}`, { recursive: true });
}
await build({
  entryPoints: ['server/pages.ts'],
  outfile: `${output}/_worker.js`,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  minify: true,
});
await writeFile(
  `${output}/_routes.json`,
  `${JSON.stringify({ version: 1, include: ['/api/*'], exclude: [] }, null, 2)}\n`,
);
console.log('Pages output: static assets and the official-warning API Worker.');
