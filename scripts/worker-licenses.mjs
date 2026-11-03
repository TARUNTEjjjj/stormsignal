import { readFile, readdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

// Use the actual emitted gateway inputs so transitive runtime dependencies are
// covered without including unrelated development packages.
export async function writeWorkerLicenses() {
  const result = await build({
    entryPoints: ['server/pages.ts'],
    outfile: 'worker.js',
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    minify: true,
    write: false,
    metafile: true,
  });
  const packages = new Set();
  for (const output of Object.values(result.metafile.outputs)) {
    for (const [input, info] of Object.entries(output.inputs)) {
      const match = input.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/);
      if (info.bytesInOutput && match) packages.add(match[1]);
    }
  }
  const marker = '\n\n# Warning gateway dependencies\n';
  let notices = (await readFile('dist/third-party-licenses.md', 'utf8')).split(marker)[0];
  notices += `${marker}\nThese notices cover packages bundled into the official-warning gateway.\n`;
  for (const name of [...packages].sort()) {
    const directory = `node_modules/${name}`;
    const metadata = JSON.parse(await readFile(`${directory}/package.json`, 'utf8'));
    const licenseFile = (await readdir(directory)).find((file) =>
      /^licen[sc]e(?:[._-].*)?$/i.test(file),
    );
    let license;
    if (licenseFile) license = await readFile(`${directory}/${licenseFile}`, 'utf8');
    // This published npm package omits its root repository license. Preserve
    // the upstream notice, reviewed for this exact installed version:
    // https://github.com/nodable/val-parsers/blob/main/LICENSE
    else if (name === '@nodable/entities' && metadata.version === '3.1.0')
      license = await readFile('scripts/licenses/nodable-entities-3.1.0-LICENSE', 'utf8');
    else throw new Error(`Missing bundled dependency license: ${name}@${metadata.version}`);
    notices += `\n## ${name}@${metadata.version}\n\nLicense: ${metadata.license}\n\n${license.trim()}\n`;
  }
  await writeFile('dist/third-party-licenses.md', notices);
}
