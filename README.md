# StormSignal

[Open the live website](https://stormsignal-weather.pages.dev) · [Verification notes](docs/verification.md)

Weather with evidence. An open-source weather workspace that puts forecasts, satellite imagery, model disagreement, and official warning coverage in one view.

StormSignal is intended for public situational awareness and learning. It does not issue official warnings, certify safe routes, or replace emergency instructions. No data is not the same as no danger.

## Frontend showcase

A React + TypeScript dashboard for exploring weather evidence, with custom SVG graphics, responsive layouts and explicit loading, missing-data and offline states.

![StormSignal desktop dashboard with current conditions and the interactive forecast explorer](docs/images/dashboard-desktop.jpg)

- **Explore the forecast:** inspect individual hours with a pointer or keyboard, switch temperature/rainfall/wind, and compare available time ranges. The SVG chart preserves missing-data gaps and has an exact-value table. Data saver uses the forecast already loaded; model comparisons and map downloads remain optional.
- **Inspect the visual implementation:** [ForecastExplorer](src/components/ForecastExplorer.tsx), [AtmosphereScene](src/components/AtmosphereScene.tsx) and the [frontend design styles](src/frontend-design.css) separate interactive data graphics, decorative atmosphere artwork and presentation. The artwork is an illustration, not radar or a satellite observation.
- **Review the engineering:** follow the [UI case study and acceptance checklist](docs/ui-case-study.md), then the [dated verification record](docs/verification.md). The checklist states expected behavior; historical test results apply to their recorded release, not every later commit.

## What makes it different

- **Reach places quickly:** Chennai, San Francisco, Mumbai, Bhubaneswar (Odisha), New York City, Miami, Tokyo and London stay available as quick locations. Your saved places have a separate list. Worldwide place search supports locations beyond these shortcuts, subject to the geocoding provider's index; warning coverage is separate from forecast coverage.
- **Explore risk context:** Manila, Kolkata and Jakarta are city examples from the Philippines, India and Indonesia, the three highest-ranked countries in the [WorldRiskIndex 2026](https://www.welthungerhilfe.org/news/publications/detail/worldriskreport-2026). This is a country-level exposure/vulnerability index, not a ranking of those cities or a live warning. The sidebar includes the scope, source and attribution.
- **Read official bulletins across regions:** US NWS point warnings, India NDMA SACHET state/territory feeds, and participating national agencies through WMO SWIC. Indian bulletins show their original affected areas; they are not automatically warnings for the selected city. Missing or partial global coverage remains explicit.
- **Check local sources directly:** PAGASA and BMKG CAP feeds supplement WMO's index for the Philippines and Indonesia. Kolkata checks IMD's public district-nowcast RSS alongside the West Bengal SACHET feed. Expand **Source checks** to see which feeds responded, what each covers and what could not be verified. These bounded feeds remain incomplete, even when both sources respond.
- **Reach the issuing authority:** direct NWS Bay Area, PAGASA Metro Manila, IMD Kolkata and BMKG Jakarta links remain available even when the integrated feed is empty or unavailable. Verified official BMKG English copies are preferred; the original warning remains when a language copy cannot be verified.
- **Inspect the sky:** timestamped NASA GIBS satellite layers, recent geostationary frames where coverage permits, and a global daily true-color view. Images represent their displayed observation time, not an instantaneous view of a street.
- **Compare rather than conceal disagreement:** ECMWF IFS and NOAA GFS model forecasts. Differences between two models are not calibrated forecast probabilities.
- **See the evidence:** forecast-based hazard indicators are separate from official alerts; imagery capture times and unavailable feeds remain visible.
- **See regional context:** recent GDACS cyclone, flood and wildfire reports filtered by distance to their representative points. Overall humanitarian-impact tiers remain separate from local warnings and hazard boundaries.
- **Start with the essentials:** Data saver is the default: a compact 24-hour forecast and supported warning checks, with no maps, satellite, extra feeds or periodic polling. Full workspace remains available on demand.
- **Carry an offline field kit:** a self-contained ~25 KB HTML file with hazard action cards, a personal communication plan, checklist, print/PDF and JSON backup. Download a personalized copy from `/offline.html`.
- **Save weather before losing service:** retain three dated briefings with bounded forecast and official-warning text. Offline copies always show that current status is unknown; export a plain-text copy for separate access.
- **Stay aware while browsing:** opt-in page notifications for retrieved NWS alerts. They require the page to stay open and are not a background emergency-warning service.
- **Keep control:** no account, advertising, app analytics, or API key required for the current public-data integrations. Saved preferences remain in the browser. Providers still receive network requests; see [privacy](docs/privacy.md).

## Run locally

City search supports Arrow Up/Down, Enter and Escape. Mobile navigation keeps keyboard focus inside the drawer, closes with Escape and restores focus to its opener. A changed city name or administrative region starts a new warning lookup even when the coordinates are unchanged.

Use Node.js 22.12 or newer (Node 24 LTS also works with the build toolchain).

```sh
npm ci
npm run dev
```

Open the URL printed by Vite. The app requires an internet connection for new forecasts, alert retrieval and map tiles. A downloaded emergency kit remains useful without a connection. See [offline preparation and use](docs/offline.md).

The production build generates a versioned service worker. After a successful online installation, it caches the essential interface, offline kit and preparedness sheet. Optional map/report chunks are excluded from initial caching and load only in Full workspace. A stalled dashboard request falls back to the installed interface after three seconds. The UI verifies the critical cache before reporting offline readiness. Storage eviction and first-ever offline visits remain limitations; keep a downloaded or printed copy.

All interface fonts are local system fonts. **Offline only** pauses weather-provider requests and online search. It does not prevent the browser checking the website or its service worker for updates. The downloaded kit contains no background network requests and no live weather. Source links and telephone actions need their respective connections.

```sh
npm test          # deterministic unit tests
npm run build    # TypeScript check and production bundle in dist/
npm run preview  # preview the production bundle locally
node --import tsx scripts/check-live-alerts.ts --live # opt-in real-provider checks after build
```

Tests use fixtures and mocks where appropriate. Passing them does not prove that a third-party feed is presently reachable or that a forecast is accurate. Provider responses and visual flows also need live verification before each release.

## Publish an update

The existing Cloudflare Pages project is `stormsignal-weather`, with production
branch `main`. Keep the project and canonical address stable. Use the owner's
Cloudflare account; credentials must never be committed.

```sh
npm ci
npm test
npm run build
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

## Architecture

The React + TypeScript interface is built with Vite. Leaflet renders the map. Cloudflare Pages serves the static interface, and a Pages Function handles the fixed-source `/api/alerts` endpoint for India and WMO feeds, which do not permit direct browser access. Weather, imagery and NWS requests remain direct. There is no account database or paid API credential.

The warning gateway accepts validated coordinates/country/region metadata, never an arbitrary upstream URL. It uses bounded response sizes, deadlines and concurrent-request limits. Shared edge caching and ETag revalidation reduce repeated CAP downloads; failed revalidation never serves old warnings as current. Raw public feeds may remain cached for 24 hours only to support conditional revalidation; ordinary warning checks require revalidation after 60 seconds. The WMO source registry is cached for six hours and is not a live feed-health signal. User-specific warning responses have `Cache-Control: no-store`.

Direct PAGASA/BMKG ingestion checks up to 20 recent CAP documents, four concurrently within 14 seconds, with original polygon/circle matching. WMO runs alongside it to supplement the bounded national history. Cross-source references suppress cancelled/superseded CAP records; direct verified copies take precedence and exact repeated bulletin content is deduplicated. One unavailable source leaves verified results from the other visible with an explicit missing-source status. Both failing returns an unavailable check, never an all-clear. Kolkata retains distinct district and state-wide scopes; its public IMD feed is a rolling national list and can omit Kolkata. No authenticated IMD API credentials are used.

For BMKG warnings, up to six WMO-linked official English copies are optionally checked, three concurrently with a 1.5-second wait limit. New language checks stop after 14 seconds of the 16-second overall check budget. Matching CAP identity, reference chain, validity, hazard level and area geometry are required; a missing, late or mismatched copy cannot replace the verified original. This is publisher-provided text, not machine translation.

| Area                                                        | Files                                                                                                                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider validation, requests and data normalization        | `src/data.ts`, `src/types.ts`                                                                                                                                     |
| Official warning gateway, CAP parsing and regional matching | `server/http.ts`, `server/cap.ts`, `server/india.ts`, `server/global.ts`, `server/national.ts`, `server/kolkata.ts`, `server/local-alerts.ts`, `server/router.ts` |
| Pages Function, preview Worker and artifact smoke checks    | `server/pages.ts`, `server/index.ts`, `scripts/`                                                                                                                  |
| Transparent forecast-based hazard indicators                | `src/risk.ts`                                                                                                                                                     |
| Satellite layer selection and available observation times   | `src/imagery.ts`                                                                                                                                                  |
| Interactive satellite map and alert geometries              | `src/components/WeatherMap.tsx`                                                                                                                                   |
| GDACS report retrieval and local distance filtering         | `src/disasters.ts`, `src/components/DisasterWatch.tsx`                                                                                                            |
| Self-contained emergency plan and preparedness              | `public/offline.html`, `public/preparedness.html`                                                                                                                 |
| Connection policy and historical briefings                  | `src/connectivity.ts`, `src/offline.ts`, `src/components/OfflineBriefing.tsx`                                                                                     |
| Atomic offline shell and optional-download isolation        | `public/sw.js`, `vite.config.ts`, `src/components/OptionalPanel.tsx`                                                                                              |
| Unit tests                                                  | `tests/`                                                                                                                                                          |

The map uses source-provided alert geometry when available. Some valid official alerts have no polygon; a missing outline does not invalidate their text. Location search results and forecast grids can differ from exact GPS coordinates. A GPS fix or map click has no verified country metadata, so official warnings ask you to select a city from search or quick locations; no warning source is checked for an unidentified country. This is not an unsupported-country result or an all-clear.

In Full workspace, supported alert feeds are checked every minute while the dashboard is visible and online. Weather panels refresh every 15 minutes, with bounded in-memory caches; returning to the visible dashboard requests another refresh. Satellite metadata has its own refresh cadence. Data saver requests essentials on load, location change, reconnection or deliberate refresh; it does not poll. A warning check older than two minutes is shown as needing refresh, rather than continuing to claim a current warning status. Fetch time is not a provider model-run or observation time.

GDACS regional reports refresh every 10 minutes while visible and online. The adapter requests a recent 14-day window for cyclone, flood and wildfire reports at all three impact tiers, capped at two pages of 100 global records. The UI identifies truncated/partial snapshots, offers 250 / 1,000 / 5,000 km search distances, and displays up to four matching reports. Distance filtering happens in the browser, not at the provider. Distance to a representative point is not the extent of an affected area.

## Coverage and limits

| Feature                               | Coverage                                                                                                            | Important limit                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forecasts and model comparison        | Global forecast grids via Open-Meteo                                                                                | Modeled estimates, not local instrument observations; resolution and update times vary.                                                                                                                                                                                                                     |
| Air quality                           | CAMS model output via Open-Meteo                                                                                    | Regional/global grid estimates; not a street-level air sensor.                                                                                                                                                                                                                                              |
| Near-real-time satellite              | Supported geostationary viewing areas                                                                               | Capture delay, limb distortion, missing frames and viewing limits apply.                                                                                                                                                                                                                                    |
| Daily true-color satellite            | Global NASA GIBS product                                                                                            | Clouds, polar night, orbital gaps and processing delays affect availability.                                                                                                                                                                                                                                |
| In-app official warnings              | US NWS; direct PAGASA, BMKG and IMD Kolkata feeds; Indian regional SACHET feeds; participating WMO SWIC authorities | Global coverage is incomplete. Indian SACHET feeds are regional, not city-specific; Kolkata also gets IMD's district nowcast. Up to 20 direct PAGASA/BMKG documents, 10 Indian SACHET entries or 6 WMO source documents are checked; missing/unmapped feeds and invalid or absent expiry can omit warnings. |
| Regional disaster reports             | Retrieved GDACS cyclone, flood and wildfire reports                                                                 | Recent reports, not a complete global warning feed; 200-record retrieval cap and representative-point distance limits apply.                                                                                                                                                                                |
| Offline field kit and saved briefings | General preparation and explicitly saved, dated local copies                                                        | No new warnings offline. Local authorities' current instructions take precedence. No live shelter or evacuation routing.                                                                                                                                                                                    |

See [data sources and licensing](docs/data-sources.md) and [imagery details](docs/imagery.md). The app cannot guarantee notification delivery, availability, or detection of every hazard. Do not rely on it as your only warning channel.

### Hosting and traffic

`npm run build` produces the deployable `pages-dist/` directory: static files, an advanced-mode `_worker.js` for the warning API, and `_routes.json` restricting Function invocations to `/api/*`. Static requests bypass Functions. The build excludes internal preview bundles and build metadata from the deployment. It also produces `dist/server/index.js`, a self-contained Worker with embedded assets for `npm run preview` and release verification; `npm run dev` includes the warning API middleware. Publishing only static files without the Pages Worker will not provide the India/WMO endpoint. Direct-browser requests still depend on the providers' CORS policies. Open-Meteo's free API is for **non-commercial use** and currently requires fewer than **10,000 calls/day**, **5,000/hour**, and **600/minute**, with limits applied by IP and application. An open-source code license does not remove those service limits. Do not assume this deployment supports an arbitrary number of simultaneous users.

For a commercial or high-traffic deployment, arrange suitable provider access, review map tile policies, implement an appropriate server cache and rate limits, and measure capacity. Keep paid API credentials server-side; Vite environment variables are included in the browser bundle. This repository contains no paid credentials.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Improvements to alert coverage, accessibility, provider resilience and documented verification are especially useful. Please include evidence for data and safety claims. Work is published using real commit times and attributable source changes; third-party notices must be preserved.

## License

Original application code is available under the [MIT license](LICENSE). Weather data, imagery, map tiles, provider names and third-party libraries retain their respective terms and attribution requirements. MIT licensing of the code is not a redistribution license for every displayed dataset.


Release builds include `/third-party-licenses.md` for both the browser bundles and the warning gateway, including their emitted transitive dependencies. The gateway notice is derived from the bundle metadata and installed package licenses; the upstream MIT notice omitted from the published `@nodable/entities@3.1.0` package is preserved under `scripts/licenses/`.
