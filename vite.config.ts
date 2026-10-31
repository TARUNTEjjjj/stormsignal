import { defineConfig, type Manifest } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Follow static imports only: optional satellite code must not consume a field
// user's bandwidth just because the app is preparing itself for offline use.
const offlineShell = {
  name: 'stormsignal-offline-shell',
  async closeBundle() {
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
    const hash = createHash('sha256').update(worker).update(JSON.stringify({ files, optional }));
    for (const file of [
      'index.html',
      'preparedness.html',
      'offline.html',
      'favicon.svg',
      'icon.svg',
      'manifest.webmanifest',
    ]) {
      hash.update(await readFile(`dist/${file}`));
    }
    const version = hash.digest('hex').slice(0, 12);
    await writeFile(
      'dist/sw.js',
      worker
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
    console.log(
      `Offline shell: ${files.length} critical assets; ${optional.length} optional assets left on demand.`,
    );
  },
};
export default defineConfig({
  plugins: [react(), offlineShell],
  build: { target: 'es2022', manifest: true },
});
