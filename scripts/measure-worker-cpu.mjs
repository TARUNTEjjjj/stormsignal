// Measure the IMD district-feed check in the Workers runtime (workerd) with synthetic fixtures.
// Usage: npm run measure:worker-cpu [-- --out docs/evidence/<dir>/results.json]
// It starts tests/worker-cpu/harness.ts with a pinned `wrangler dev` at this repository's Worker
// compatibility date, on 127.0.0.1 only, and never contacts a weather provider. See
// docs/deployment.md#worker-cpu-budget for what the numbers do and do not show.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { cpus, tmpdir, totalmem, release, arch } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The first Wrangler release whose bundled workerd (1.20261103.1) supports the repository's
// compatibility date; older ones fall back to an earlier date. Change both together.
const WRANGLER = '4.157.0';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outIndex = process.argv.indexOf('--out');
const out = outIndex > 0 ? resolve(process.argv[outIndex + 1]) : null;
const port = Number(process.env.HARNESS_PORT || 8798);

const config = await readFile(join(root, 'wrangler.jsonc'), 'utf8');
const compatibilityDate = /"compatibility_date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/.exec(config)?.[1];
if (!compatibilityDate) throw new Error('wrangler.jsonc has no compatibility_date');

const work = await mkdtemp(join(tmpdir(), 'stormsignal-cpu-'));
await writeFile(
  join(work, 'wrangler.json'),
  JSON.stringify({
    name: 'stormsignal-cpu-harness',
    main: join(root, 'tests/worker-cpu/harness.ts'),
    compatibility_date: compatibilityDate,
  }),
);
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' };
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const wranglerVersion = execFileSync(npx, ['--yes', `wrangler@${WRANGLER}`, '--version'], {
  env,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .pop();
const child = spawn(
  npx,
  [
    '--yes',
    `wrangler@${WRANGLER}`,
    'dev',
    '--config',
    join(work, 'wrangler.json'),
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--persist-to',
    join(work, 'state'),
    '--log-level',
    'warn',
  ],
  { env, stdio: ['ignore', 'pipe', 'pipe'] },
);
let log = '';
child.stdout.on('data', (chunk) => (log += chunk));
child.stderr.on('data', (chunk) => (log += chunk));
const base = `http://127.0.0.1:${port}`;

async function waitForHarness() {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited:\n${log}`);
    try {
      const response = await fetch(`${base}/fixtures`);
      if (response.ok) return response.json();
    } catch {
      /* Not listening yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Harness did not start:\n${log}`);
}
/** The workerd processes started by this wrangler dev session. */
function workerdPids() {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .map(([pid, ppid, ...command]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      command: command.join(' '),
    }));
  const tree = new Set([child.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows)
      if (tree.has(row.ppid) && !tree.has(row.pid)) {
        tree.add(row.pid);
        grew = true;
      }
  }
  return rows
    .filter((row) => tree.has(row.pid) && /workerd/.test(row.command))
    .map((row) => row.pid);
}
/** User + system CPU time (ms) the operating system has charged to these processes. */
function processCpuMs(pids) {
  const output = execFileSync('ps', ['-o', 'time=', '-p', pids.join(',')], { encoding: 'utf8' });
  return output
    .trim()
    .split('\n')
    .map((value) => value.trim().split(':').map(Number))
    .reduce((sum, parts) => sum + parts.reduce((total, part) => total * 60 + part, 0) * 1000, 0);
}
/**
 * CPU per run as charged by the OS, independent of the runtime's 1 ms timer: the difference
 * between a request that repeats the work `runs + 1` times and one that does it once, so request
 * handling and fixture generation cancel out.
 */
async function osCpuPerRun(path, runs) {
  const pids = workerdPids();
  if (!pids.length) return null;
  const charged = async (count) => {
    const before = processCpuMs(pids);
    await get(`${path}&runs=${count}`);
    return processCpuMs(pids) - before;
  };
  const once = await charged(1);
  const many = await charged(runs + 1);
  return { runs, msPerRun: Math.round(((many - once) / runs) * 100) / 100 };
}
async function get(path) {
  const response = await fetch(`${base}${path}`);
  const body = await response.json();
  if (!response.ok) throw new Error(`${path}: ${JSON.stringify(body)}`);
  return body;
}

try {
  const fixtures = await waitForHarness();
  const near = fixtures[fixtures.length - 1];
  const q = (fixture) => encodeURIComponent(fixture);
  // First request to a fresh isolate: includes parser JIT warm-up, as a newly started isolate would.
  const cold = await get(`/parse?fixture=${q(near)}&runs=1`);
  const parse = [];
  for (const fixture of fixtures) parse.push(await get(`/parse?fixture=${q(fixture)}&runs=30`));
  const requests = [];
  for (const fixture of fixtures)
    requests.push(await get(`/request?fixture=${q(fixture)}&latency=0&runs=10`));
  requests.push(await get(`/request?fixture=${q(near)}&latency=400&runs=5`));
  const osCpu = {};
  for (const fixture of fixtures) {
    osCpu[fixture] = {
      adapter: await osCpuPerRun(`/parse?fixture=${q(fixture)}`, 100),
      request: await osCpuPerRun(`/request?fixture=${q(fixture)}&latency=0`, 100),
    };
  }
  const limits = [];
  for (const name of await get('/limits')) limits.push(await get(`/limit?case=${q(name)}`));
  const result = {
    measuredAt: new Date().toISOString(),
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    runtime: {
      wrangler: wranglerVersion,
      compatibilityDate,
      note: 'Local workerd via wrangler dev; not the deployed Cloudflare runtime or hardware.',
    },
    machine: {
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      memoryGiB: Math.round(totalmem() / 2 ** 30),
      os: `${process.platform} ${release()} ${arch()}`,
      node: process.version,
    },
    coldFirstParse: cold,
    parse,
    requests,
    osCpu,
    limits,
  };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (out) {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, text);
  }
  process.stdout.write(text);
  const failed = limits.filter((item) => !item.passed);
  if (failed.length) {
    console.error(`Limit checks failed: ${failed.map((item) => item.case).join(', ')}`);
    process.exitCode = 1;
  }
} finally {
  child.kill('SIGINT');
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => (child.kill('SIGKILL'), resolve()), 5000);
    child.once('exit', () => (clearTimeout(timer), resolve()));
  });
  await rm(work, { recursive: true, force: true });
}
