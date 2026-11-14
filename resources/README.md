# StormSignal evidence resources

The catalog is a reference shelf for weather, climate and mapping tools. Official warning and forecast adapters remain the operational data sources. Repository popularity is never evidence of a weather warning or safety.

## Use the collection

`catalog.json` is the public, versioned resource database. `sources.json` controls categories, curated repositories, the discovery star threshold and collection bounds. Every fetched record includes its GitHub URL, observed star count, repository license identifier when GitHub recognizes it, last push time and collection time. License metadata is a pointer to review, not permission to redistribute repository contents.

With Node.js 20 or later, run from the repository root:

```sh
node --test scripts/resources/resource-catalog.test.mjs
node scripts/resources/check-catalog.mjs
node scripts/resources/resource-server.mjs refresh --config resources/sources.json --output resources/catalog.json
node scripts/resources/resource-server.mjs serve --config resources/sources.json --snapshot resources/catalog.json --port 8787
```

The optional local API is `http://127.0.0.1:8787/api/resources`. It accepts `category`, `q` and `limit` filters. Serving reads the local snapshot and makes no upstream requests. Refresh belongs in a server or CI job; an optional `GITHUB_TOKEN` comes from the environment and is never written to a snapshot. The API binds to loopback and accepts additional browser origins only through an explicit `--origins` list.

## Selection and freshness

Discovery searches public non-forked, non-archived repositories with at least 500 stars. Curated seeds may have fewer stars when they are useful primary references. The collection rejects archived, disabled and private sources, bounds upstream requests, deduplicates within each category, and ranks by category relevance, logarithmic star count and recent maintenance. Each category publishes at most 12 entries. A repository can belong to several categories.

Stars measure popularity, not correctness or suitability. No source code, README instructions or remote scripts are executed. Newly discovered entries are links and normalized metadata; they do not automatically enter assessment, warning, or training data. Application-content imports must use a dedicated adapter with source, format, rights and validation appropriate to that data.

The refresh job uses rate-limit cooldowns and conditional requests when its local sidecar exists. Hosted Actions runners start without that ignored sidecar, so daily CI fetches bounded fresh metadata; API serving always uses the public snapshot. Failed or incomplete sources preserve their last good entries with stale/error information. A cold start can provide clearly marked curated links with unknown star counts. Public snapshots omit the transport cache, stored in ignored `catalog.json.cache.json`. The API checks time-based freshness; the resource explorer labels the published snapshot and shows observation dates rather than describing historical metadata as a live feed.

## Automated updates

`.github/workflows/resources.yml` tests changes and, after it reaches the default branch, refreshes once daily or through **Run workflow**. A usable validated refresh commits only the public snapshot (and the native bundle copy in Forge for Mac). Partial refreshes publish validated last-good entries with stale/error information and a workflow warning. Fatal refresh or validation errors stop before committing; branch protections can also prevent the bot push. The workflow has read-only permissions for tests and grants content-write permission only to the refresh job.

The deployed resource explorer fetches the latest public catalog from this repository's default branch through GitHub's raw-content CDN, with bounded requests and project/schema validation. It uses the bundled snapshot when remote metadata is unavailable. CDN caching can briefly delay new entries; the interface shows observation dates and its data source. A catalog-only update therefore reaches the deployed explorer without rebuilding the application. Application code changes still follow the existing deployment procedure. The optional local API reads the on-disk snapshot; no GitHub credential goes into a browser build.

## Source policy

- **Weather and climate data tools**: [open-meteo/open-meteo](https://github.com/open-meteo/open-meteo), [Unidata/MetPy](https://github.com/Unidata/MetPy), [pydata/xarray](https://github.com/pydata/xarray). Discovery: `topic:weather`.
- **Geospatial visualization**: [Leaflet/Leaflet](https://github.com/Leaflet/Leaflet), [maplibre/maplibre-gl-js](https://github.com/maplibre/maplibre-gl-js). Discovery: `topic:geospatial`.

Implementation follows the official [GitHub search API](https://docs.github.com/en/rest/search/search), [repository search syntax](https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories), and [API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).

## Automatic checks and offline collections in the web app

While an app or resource-library tab is open, the browser checks the fixed public GitHub snapshot on startup and every 15 minutes after the preceding check completes. Returning to a tab, restoring it from the back/forward cache, or reconnecting checks again when due. Background-tab throttling and device sleep can defer a timer; a closed browser does not run these checks. This is separate from the daily server-side GitHub collection job.

Validated public metadata is saved in this site's IndexedDB storage. The saved edition is available immediately on later visits, and an older CDN response cannot replace newer saved data. Network or validation failures preserve the last valid collection; storage denial or quota failures are reported without blocking the library. Source observation dates remain unchanged, and the library distinguishes the last successful check from the collection date.

A service worker scoped to `/resources/` saves the resource-library page and its explicit public assets. It does not take over the main application, cache arbitrary URLs, or delete the application's existing caches. After an online visit prepares this library, it can reopen offline with its latest saved catalog. Browser storage can be cleared or evicted, and private browsing or policy restrictions can prevent saving; the UI reports availability. The catalog contains reference metadata and links, not offline copies of the third-party repositories or websites. Learning progress, notes, credentials and operational application data are not stored in this resource cache.
