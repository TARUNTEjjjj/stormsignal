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

While it is busy (half of the shared upstream read capacity in use, or eight lookups running), the warning API refuses a client's fifth distinct lookup while four are still running (HTTP 429; eight for all addresses of one IPv6 /48), which limits how much of that capacity one connection can take from other users. The limit applies within one Worker instance. It does not limit request rates or Pages Functions usage, and it cannot stop traffic that comes from many networks; that needs a platform rate limit. A Kolkata check validates and parses IMD's whole national district feed (up to 1,000 entries and 1 MB), the most CPU-intensive step of any warning check; on a plan with a small CPU allowance per request, confirm that such a check still completes when the feed is long. For a commercial or high-traffic deployment, arrange suitable provider access, review map tile policies, implement an appropriate server cache and rate limits, and measure capacity. Keep paid API credentials server-side; Vite environment variables are included in the browser bundle. This repository contains no paid credentials.
