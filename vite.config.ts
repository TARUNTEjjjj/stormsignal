import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
// Pin the app-shell cache to this build and precache hashed assets on the first visit.
const offlineShell = {
  name: 'stormsignal-offline-shell',
  async closeBundle() {
    const files = (await readdir('dist/assets'))
      .filter((name) => /\.(js|css|woff2?)$/.test(name))
      .map((name) => `/assets/${name}`);
    const worker = await readFile('public/sw.js', 'utf8');
    const version = createHash('sha256')
      .update(worker)
      .update(files.join(','))
      .update(await readFile('public/preparedness.html', 'utf8'))
      .digest('hex')
      .slice(0, 12);
    await writeFile(
      'dist/sw.js',
      worker
        .replace(
          /const VERSION\s*=\s*['"]stormsignal-v1['"];?/,
          `const VERSION='stormsignal-${version}';`,
        )
        .replace(/const BUILD_ASSETS\s*=\s*\[\];/, `const BUILD_ASSETS=${JSON.stringify(files)};`),
    );
  },
};
export default defineConfig({ plugins: [react(), offlineShell], build: { target: 'es2022' } });
