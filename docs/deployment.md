# Deployment and operations

[Back to StormSignal](../README.md)

## Publish an update

The existing Cloudflare Pages project is `stormsignal-weather`, with production
branch `main`. Keep the project and canonical address stable. Use the owner's
Cloudflare account; credentials must never be committed.

```sh
npm ci
npm run check
npx wrangler@4.153.0 pages deploy pages-dist --project-name stormsignal-weather --branch main
```

This is a Wrangler Direct Upload project. A Git push alone does not publish the
website. The Pages output includes the warning API; do not upload `dist/` or omit
`_worker.js`. No database, application secret or additional resource binding is
required. `ASSETS` is the built-in Pages static-file binding. API requests are
subject to the account's Pages Functions limits; static files do not invoke it.

### Browser data after the address change

Saved places, settings, dated briefings, emergency-kit plans and offline caches
belong to the website address where they were created. They are not automatically
copied to this new address. Existing data remains in the previous website's
browser storage. Before switching, download any needed text briefings and use
**Export plan backup** or **Download offline HTML** in the old emergency kit.
Use **Restore a plan backup** in the new kit, then save it on the device. Saved
places and display preferences can be selected again. Do not clear the previous
site's storage until the copies you need have been verified.

## Hosting and traffic

`npm run build` produces the deployable `pages-dist/` directory: static files, an advanced-mode `_worker.js` for the warning API, and `_routes.json` restricting Function invocations to `/api/*`. Static requests bypass Functions. The build excludes internal preview bundles and build metadata from the deployment. It also produces `dist/server/index.js`, a self-contained Worker with embedded assets for `npm run preview` and release verification; `npm run dev` includes the warning API middleware. Publishing only static files without the Pages Worker will not provide the India/WMO endpoint. Direct-browser requests still depend on the providers' CORS policies. Open-Meteo's free API is for **non-commercial use** and currently requires fewer than **10,000 calls/day**, **5,000/hour**, and **600/minute**, with limits applied by IP and application. An open-source code license does not remove those service limits. Do not assume this deployment supports an arbitrary number of simultaneous users.

While it is busy (half of the shared upstream read capacity in use, or eight lookups running), the warning API refuses a client's fifth distinct lookup while four are still running (HTTP 429; eight for all addresses of one IPv6 /48), which limits how much of that capacity one connection can take from other users. The limit applies within one Worker instance. It does not limit request rates or Pages Functions usage, and it cannot stop traffic that comes from many networks; that needs a platform rate limit. A Kolkata check validates and parses IMD's whole national district feed (up to 1,000 entries and 1 MB), the most CPU-intensive step of any warning check. Measured locally, a near-bound feed needed more CPU than the Workers Free allowance; see [Worker CPU budget](#worker-cpu-budget). For a commercial or high-traffic deployment, arrange suitable provider access, review map tile policies, implement an appropriate server cache and rate limits, and measure capacity. Keep paid API credentials server-side; Vite environment variables are included in the browser bundle. This repository contains no paid credentials.

## Worker CPU budget

Measured 19 November 2026 in a reproducible local harness, not on the deployed site.
Raw results: [`docs/evidence/worker-cpu-2026-11-19/results.json`](evidence/worker-cpu-2026-11-19/results.json).

**Cloudflare's published limits.** Workers
[CPU time](https://developers.cloudflare.com/workers/platform/limits/#cpu-time) is
**10 ms per HTTP request on Workers Free** and **30 seconds by default (configurable
up to 5 minutes) on Workers Paid**. Time spent waiting on a network request does not
count. A request that exceeds its limit fails with error 1102. Pages Functions count
toward the account's Workers plan
([Pages limits](https://developers.cloudflare.com/pages/platform/limits/#functions));
that page does not restate the CPU figure, so confirm the effective limit for this
project in the dashboard.

**Harness.** `npm run measure:worker-cpu` starts
[`tests/worker-cpu/harness.ts`](../tests/worker-cpu/harness.ts) in workerd with
`wrangler@4.157.0 dev` (workerd 1.20261103.1, the first release that supports this
project's compatibility date, `2026-10-30`), bound to 127.0.0.1. The global `fetch` is
replaced with an in-process fake, so **no provider is contacted**. Synthetic feeds
([`tests/worker-cpu/imd-fixtures.ts`](../tests/worker-cpu/imd-fixtures.ts)) copy the
observed item layout and place the Kolkata entry last: a short feed of 20 entries,
1,000 entries at the observed size (629 KB), and 1,000 entries padded to exactly
1,000,000 bytes. They are the parser's entry and byte bounds. Each scenario measures
the Kolkata adapter alone and a whole `/api/alerts` request through the production
Pages entry (`server/pages.ts`). Waiting on the simulated network is timed separately
and subtracted. CPU is reported two ways: the runtime clock around work that does no
I/O (1 ms resolution), and the CPU time macOS charged to the workerd process over 100
repetitions.

Results on an Apple M5 (macOS, Node 26.13.0), with the server code at `42728d8`:

| Feed                  | Adapter, median (p95) | Whole request, median (p95) | Whole request, OS-charged |
| --------------------- | --------------------: | --------------------------: | ------------------------: |
| 20 entries, 13 KB     |           0 ms (1 ms) |                 1 ms (8 ms) |                    2.4 ms |
| 1,000 entries, 629 KB |         12 ms (14 ms) |               14 ms (16 ms) |                   18.3 ms |
| 1,000 entries, 1 MB   |         12 ms (14 ms) |               14 ms (16 ms) |                   19.3 ms |

- The first 1 MB parse in a new isolate took **32 ms** (parser warm-up).
- About a quarter of the adapter's time is XML validation (2–3 ms) and two thirds is
  building the parsed document (8–9 ms). The cost follows the number of elements rather
  than the bytes, so the 629 KB and 1 MB feeds cost about the same.
- With a simulated 400 ms upstream delay, a 1 MB request took 424 ms (median) of wall
  time, of which 402 ms was the network wait; that wait does not count as CPU time.
- The OS-charged figure includes workerd's request handling and garbage collection. An
  earlier run the same day, before the evidence file was written, charged 15.2 ms and
  20.5 ms for the two 1,000-entry requests; expect a few milliseconds of variation.

**Bounded read, timeout and errors** in workerd (all passed): a declared
`Content-Length` above 1 MB and an undeclared body that grows past 1 MB are both
rejected; a provider that never sends headers, or stalls mid-body, times out after
**8.0 s**; HTTP 503 and a connection error are retried once after about 150 ms and
then reported; HTTP 404 is not retried; malformed XML and a 1,001-entry feed are
rejected.

**Assessment.** A short feed is well inside every plan. A near-bound feed needs about
**12–20 ms** of CPU on this machine, which is **above the Workers Free 10 ms
allowance** and far below the Workers Paid default. Cloudflare's servers and isolate
state differ from this Mac, so the deployed figure may be higher or lower.

**Remedy considered.** Parser options were measured on the 1 MB feed: ignoring
attributes or skipping HTML entities saves at most 7%, and stopping description
parsing saves nothing. None of these brings a near-bound check under 10 ms, and two of
them change what the parser accepts. A larger reduction would mean replacing the
library parse with a custom XML scanner, a correctness risk for a warning parser that
is not justified until the plan is known. The remedy is therefore a **hosting-plan
decision**. Keep this project on Workers Paid, or accept that a Kolkata check can fail
(error 1102, shown as an unavailable source) on Free when IMD's feed is long. If
parser work is reduced later, rerun the harness and record the new results here.

**Owner follow-up (needs the Cloudflare account).** Record the deployed revision, the
project's plan and effective CPU limit, and the `/api/alerts` CPU-time and error
metrics (Workers & Pages → stormsignal-weather → Metrics) over a period that includes a
long IMD feed. These were not available for this measurement.
