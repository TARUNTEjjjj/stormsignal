import { defineConfig, type Manifest } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile, writeFile } from 'node:fs/promises';
import { handleAlerts } from './server/router.ts';
// @ts-expect-error Native ESM build helpers are shared with the static apps.
import { readAppRelease, stampAppVersion, writeAppVersion } from './scripts/app-release.mjs';
// @ts-expect-error Native ESM build helper.
import { workerUpdateProtocolSource } from './scripts/app-update-protocol.mjs';
// @ts-expect-error Native ESM staging helper.
import { stageResourceExplorer } from './scripts/stage-resource-explorer.mjs';

// Follow static imports only: optional satellite code must not consume a field
// user's bandwidth just because the app is preparing itself for offline use.
const offlineShell = {
  name: 'stormsignal-offline-shell',
  async closeBundle() {
    const release = await readAppRelease(process.cwd(), {project:'stormsignal',
      sourcePaths:['src','public','resources','server','index.html','vite.config.ts','package.json','package-lock.json','scripts'],
      ignorePaths:['public/resources']});
    await stageResourceExplorer(process.cwd(), 'dist/resources', {release});
    for (const file of ['index.html', 'preparedness.html', 'offline.html'])
      await writeFile(`dist/${file}`, stampAppVersion(await readFile(`dist/${file}`, 'utf8'), release));
    const manifest: Manifest = JSON.parse(await readFile('dist/.vite/manifest.json', 'utf8'));
    const critical = new Set<string>();
    const visited = new Set<string>();
    function visit(key: string) {
      if (visited.has(key)) return;
      visited.add(key);
      const chunk = manifest[key];
      if (!chunk) throw new Error(`Missing offline entry dependency: ${key}`);
      critical.add(`/${chunk.file}`);
      for (const file of [...(chunk.css || []), ...(chunk.assets || [])]) critical.add(`/${file}`);
      for (const dependency of chunk.imports || []) visit(dependency);
    }
    const entries = Object.entries(manifest).filter(([, chunk]) => chunk.isEntry);
    if (!entries.length) throw new Error('No application entry found for offline installation');
    for (const [key] of entries) visit(key);
    const all = new Set<string>();
    for (const chunk of Object.values(manifest)) {
      for (const file of [chunk.file, ...(chunk.css || []), ...(chunk.assets || [])])
        all.add(`/${file}`);
    }
    const files = [...critical].sort();
    const optional = [...all].filter((file) => !critical.has(file)).sort();
    const worker = await readFile('public/sw.js', 'utf8');
    const version = release.version.slice(0, 12);
    await writeFile(
      'dist/sw.js',
      worker
        .replace("const APP_VERSION = 'development';", `const APP_VERSION=${JSON.stringify(release.version)};`)
        .replace('/* APP_UPDATE_PROTOCOL */', workerUpdateProtocolSource({
          readyExpression:'(await Promise.all([...DOCUMENTS,...STATIC_FILES,...BUILD_ASSETS].map(async path=>(await caches.open(VERSION)).match(path,{ignoreVary:true})))).every(Boolean)',
        }))
        .replace(
          /const VERSION\s*=\s*['"]stormsignal-v1['"];?/,
          `const VERSION='stormsignal-${version}';`,
        )
        .replace(/const BUILD_ASSETS\s*=\s*\[\];/, `const BUILD_ASSETS=${JSON.stringify(files)};`)
        .replace(
          /const OPTIONAL_ASSETS\s*=\s*\[\];/,
          `const OPTIONAL_ASSETS=${JSON.stringify(optional)};`,
        ),
    );
    await writeAppVersion('dist', release, {workers:[{scope:'/',script:'/sw.js'},{scope:'/resources/',script:'/resources/offline-worker.js'}]});
    console.log(
      `Offline shell: ${files.length} critical assets; ${optional.length} optional assets left on demand.`,
    );
  },
};
export default defineConfig({
  plugins: [
    react(),
    offlineShell,
    {
      name: 'official-warning-api',
      configureServer(server) {
        server.middlewares.use('/api/alerts', async (req, res) => {
          const result = await handleAlerts(
            new Request(`http://localhost/api/alerts${req.url === '/' ? '' : req.url}`, {
              method: req.method,
            }),
          );
          res.writeHead(result.status, Object.fromEntries(result.headers));
          res.end(Buffer.from(await result.arrayBuffer()));
        });
      },
    },
  ],
  build: { target: 'es2022', manifest: true, license: { fileName: 'third-party-licenses.md' } },
});
