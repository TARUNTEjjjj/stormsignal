# Release verification

## Globe test gaps — 20 November 2026

The random spot check recorded on 19 November found one-line changes to the globe code that
no test caught. Only tests changed in response; no application file did, so the hosted
build is unchanged.

- Its 9 changes, and a tenth found while reproducing them (the upload flag on NASA's decoded
  image), are now caught, except two that change nothing a user, the browser or memory use
  can see. One is the abort listener's `{ once: true }`: an `AbortSignal` fires `abort` at
  most once, and the listener is always removed. The other is the starting value of the
  flag that records whether the globe was turned: a mount effect resets it before any key
  can read it, so the 19 November entry was wrong to count it as visible.
- A second random spot check, of 40 changes, found 11 more that no test caught. The 5 a user
  could see are now caught: a saved-place marker drawn under the selected place, a glow
  that would hide stars, a warning outline cut on the wrong side of the horizon, the wrong
  imagery icon on the place card, and Enter selecting the drifted centre after Home. The
  other 6 change nothing observable.
- A third random spot check, of 30 changes, caught 24. Independent judges found that 4 of
  the 6 left would be noticed, and those are now caught: a wrong screen-reader message at
  the zoom limit, the zoom hint showing all the time, a new place discarding the viewer's
  zoom, and a tab opened late gliding to where the globe already is. The other 2 change
  nothing: the daily layer's name is never read, and the antialias option is ignored
  because the globe hands three.js a context it opened itself.
- After an independent review, three tests now do what their names say: a real finger tap
  selects a place, every star is placed through the scene's real camera, and each star's
  colour follows its tint.
- The GLSL interpreter used by the tests gained `#ifdef`/`#else` handling and matrix
  column indexing, so it runs three.js's own line shader with the horizon patch.

`npm test` passed **724** application tests (708 before). Of the 24 tracked changes, 22 are
caught and the 2 described first are equivalent; all 96 earlier changes are still caught.
The build, TypeScript and Prettier passed, and the application tests also passed with `TZ`
set to UTC, Asia/Kolkata and Pacific/Kiritimati. The change scripts are kept outside the
repository, so these counts cannot be reproduced from it alone.

## Midnight Aurora redesign and 3D globe — 19 November 2026

The interface was restyled and a 3D globe added as the centrepiece of Full workspace.
A multi-agent workflow built the restyle and the globe as separate changes. Independent
review agents checked and repaired each one, the two were combined, and final
engineering, visual-design and accessibility reviews followed, then a test-coverage
round, a repair and an approving recheck. The main changes:

- **Midnight Aurora palette.** Shared tokens on `:root` in `src/frontend-design.css`: a
  midnight base, a glass sidebar and top bar, panels inside gradient hairlines, and aurora
  light kept for focus, active state and key data. System fonts only. The background
  settles once in 5 s and is static under reduced motion. The kit, guide and 404 pages
  follow the palette. Official warning severity colours are unchanged.
- **Motion** (`src/motion.ts`): sections reveal on scroll when motion is allowed, and
  cards tilt towards a fine pointer in Full workspace. Nothing moves under
  `prefers-reduced-motion`.
- **3D globe** (`src/globe.ts`, `src/globe-scene.ts`, `src/globe-shaders.ts`,
  `src/components/GlobeView.tsx`), in Full workspace only. three.js 0.187.0 loads on
  demand, and only after a WebGL 2 probe. It shows real, dated NASA GIBS imagery: the
  Blue Marble base and the NOAA-20 VIIRS daily mosaic, with its coverage stated and its
  gaps hatched. Day and night follow the sun on the warning source's clock. It draws the
  selected place, saved places and active official warning outlines, and a click, tap or
  Enter selects a point as the map does. It works fully by keyboard, with a polite live
  region. It falls back cleanly without WebGL 2, after a failed download, a lost context
  or a failed frame. It stops drawing off screen, in a hidden tab and once its minute of
  turning ends.
- **Accessibility fixes found in review.** The official warning summaries now show their
  focus ring (it was clipped away before this change too). The globe's toggles keep a
  visible on state in forced colours. On phones the warnings link's visible words begin
  its accessible name. Every Tab stop shows its ring with nothing cut off.

`npm run check` passed **814 tests** (708 application, 72 resource-library interface and
34 catalog tests; 516 application tests before this change), TypeScript, the production
browser build, the new stylesheet budget (84,261 of 90,000 bytes; 17,168 compressed),
embedded Worker checks and Pages artifact checks on macOS with Node **26.13.0** and npm
11.20.0. The application tests
also passed with `TZ` set to UTC, America/Los_Angeles, Asia/Kolkata, Pacific/Kiritimati,
Pacific/Pago_Pago and Australia/Lord_Howe, and with German, Arabic (Egypt) and Japanese
locales. Prettier reports every checked file formatted, and a clean install reported zero
known dependency vulnerabilities. Each of 96 one-line changes to the globe code (66
written with the new tests and the repair, 30 by the independent recheck) makes at least
one test fail. Those changes were aimed at the behaviour the tests describe. A later random
spot check of 24 other one-line changes in the same files found 9 that no test catches:
the device-pixel-ratio fallback, the drag's pointer check, the texture upload flag, the
star colours, the image-release guard, an abort listener option, the starting value of the
flag that records whether the globe was turned, and two decorative icons' `aria-hidden`.
Most are drawing details that the stand-in renderer cannot observe. The 20 November entry
follows them up.

Bundle sizes (raw / compressed): the entry script is 342.0 / 108.6 kB (334.3 / 106.1 kB
before) and the entry stylesheet 84.3 / 17.4 kB (51.9 / 11.9 kB before). three.js
(545.2 / 135.3 kB), the globe (61.1 kB) and its line and controls chunks (37.7 kB) load
only in Full workspace, after the WebGL 2 probe, and the service worker does not
pre-cache them.

Browser checks ran in headless Chrome on macOS (software WebGL), mostly with outside hosts
answered from fixtures, plus live NASA GIBS loads and a pass in a desktop browser against
the real services:

- Data saver loaded only the application bundle, one forecast request and one warning
  request, then made no request and drew no frame for 70 s: no globe code, no three.js,
  no imagery and no WebGL context. Offline only made no outside request.
- Full workspace requested only the hosts listed in [privacy](privacy.md). A live GIBS
  load drew the 18 November 2026 mosaic (93% of Earth imaged), and the globe came to
  rest on the selected place with its warning outline in view.
- At 1440, 1280, 1024, 768, 390 and 360 px wide, in all three modes, with reduced
  motion, in print and with always-visible scrollbars, no text was clipped or
  overlapping, nothing scrolled sideways and the console showed no errors in normal use.
- Tab order, the mobile drawer, 24 px targets, 200% and 400% zoom, 320 px reflow, text
  spacing, touch scrolling over the globe and the live regions passed. Text over the
  globe measured at least 5.8:1 over white cloud and 7.9:1 on the night side.

Commit `f22f8c0` passed repository CI (Validate on Node 22, and the resource catalog
tests) and was deployed to Cloudflare Pages production at **17:07 UTC**. The hosted site
then reported version `7014fb5e…`, and `npm run test:live` through it returned:

| City          | Elapsed | Observed provider result                                       |
| ------------- | ------: | -------------------------------------------------------------- |
| San Francisco |  2.99 s | NWS passed; three active records at that instant.              |
| Manila        |  4.48 s | PAGASA direct and WMO supplementary checks passed.             |
| Kolkata       |  2.93 s | IMD district and SACHET regional checks passed; three records. |
| Jakarta       |  4.25 s | BMKG direct and WMO supplementary checks passed.               |

On the hosted site, Data saver loaded only the application bundle and the forecast.
Switching to Full workspace loaded the globe, which drew NASA's 18 November 2026 mosaic
(93% of Earth imaged) with no console errors.

Screenshots: [desktop globe](images/aurora-globe-desktop.jpg) (Full workspace, 17:24 UTC)
and [desktop forecast explorer](images/aurora-forecast-desktop.jpg) (Data saver, 17:25
UTC), each captured for New York City from the hosted site in its own headless Chrome
load (software WebGL). They show the data of those moments, not current weather or proof
of complete provider coverage.

Not covered: Safari, Firefox, Windows and a real GPU. Forced colours were checked only
through Chrome's emulation, so the toggles and focus rings still need one look in
Windows High Contrast.

## Worker CPU budget harness — 19 November 2026

Added `npm run measure:worker-cpu`. It runs the IMD Kolkata district-feed check in
workerd (`wrangler@4.157.0 dev`, compatibility date `2026-10-30`) against synthetic
feeds of 20 entries and of 1,000 entries at 629 KB and at exactly 1 MB. Upstream
`fetch` is faked in-process, so no provider was contacted. On an Apple M5, a
near-bound check used about 12–14 ms by the runtime clock and 15–20 ms of CPU charged by
the OS for a whole `/api/alerts` request. That is above the 10 ms Workers Free
allowance. A short feed used about 2 ms. Waiting on a simulated 400 ms upstream was
measured separately from CPU. All nine bounded-read, timeout and error cases behaved as
documented in workerd. Details, the selected remedy (a hosting-plan decision) and the
owner follow-up are in [deployment](deployment.md#worker-cpu-budget). The deployed
revision, the plan's effective CPU limit and production request metrics need the owner's
Cloudflare account and were **not** recorded. Two tests check the fixtures against the
parser bounds and the production adapter.

## Submission audit — 16 November 2026

A multi-agent audit reviewed the repository by area (warning feeds, gateway, client
data, application shell, forecast explorer, offline and update machinery, resource
library, build and documentation, tests) and by concern (security, time and units,
failure handling, accessibility). Each finding was reproduced before it was fixed,
each fix arrived with a regression test, and each patch was reviewed by an
independent reviewer. Four reported findings were refuted and left unchanged. The
main behaviour changes:

- WMO matching no longer drops current warnings whose index row joins several area
  names; direct and WMO copies of one CAP information block now share an identifier,
  so a merge neither loses nor duplicates warnings; feeds longer than 100 entries are
  ordered as a whole before their detail caps apply.
- A cancelled Pages request can no longer leave a shared upstream read or an admission
  slot held for the life of the isolate. Live feeds use a 45-second cache, so a
  once-a-minute poll always reads a fresh copy.
- Data saver and Offline only no longer contact GitHub, poll `/app-version.json`,
  pre-download the resource library or register its service worker. Full workspace
  keeps that background work, now disclosed in [privacy](privacy.md). A dashboard
  launched offline no longer requests an uncached module.
- Snow is reported as snow, with its own hazard kind and precipitation wording; the
  7-day outlook keeps the right weekday across clock changes; saved places merge with
  other windows instead of overwriting them; a manual reload no longer reopens a stale
  place.
- Keyboard and screen-reader fixes: search results close when focus leaves them;
  refresh buttons stay focusable while busy; status messages stay until dismissed or
  replaced; pressed toggles have a 3:1 ring; map buttons show their focus ring; and
  the map marker, warning outlines and every standalone page carry names or icons.
- `npm run check` now also runs the resource-library suites, `npm run format:check`
  runs in CI, and `tsx` 4.23.15 removes Node 26 deprecation warnings.

`npm run check` passed **615 tests** (513 application, 72 resource-library interface
and 30 catalog tests; 461 before this review), TypeScript, the production browser
build, embedded Worker checks and Pages artifact checks on macOS with Node
**26.13.0** and npm 11.20.0. The 513 application tests also passed with `TZ` set to
UTC, America/Los_Angeles, Asia/Kolkata and Pacific/Kiritimati, and with a German
locale. Prettier reports every checked file formatted. A clean install reported zero
known dependency vulnerabilities. Repository CI separately targets Node 22.

The real local production-artifact check at **09:46 UTC** returned:

| City          | Elapsed | Observed provider result                           |
| ------------- | ------: | -------------------------------------------------- |
| San Francisco |  0.45 s | NWS passed; one active record at that instant.     |
| Manila        |  2.01 s | PAGASA direct and WMO supplementary checks passed. |
| Kolkata       |  0.75 s | IMD district and SACHET regional checks passed.    |
| Jakarta       |  7.41 s | BMKG direct and WMO supplementary checks passed.   |

In the local production browser, Data saver loaded only the application bundle, one
forecast request and one warning request; Offline only made no request; Full
workspace started the background work and the `/resources/` worker; switching modes
took effect without a reload. Search, saved places, saved briefings, the forecast
explorer, CSV export, the mobile drawer, the emergency kit, the preparedness guide,
the resource library and the 404 page showed no console errors. During this review
GDACS did not respond (the panel reported the timeout), and no active NWS warning
carried a polygon, so warning-outline names are covered by tests rather than a live
observation. This review did not redeploy the hosted site.

## Provider timeout recovery — 13 November 2026

This review fixes application-side stalls without treating a failed provider as
healthy or replacing missing official warnings with fabricated data:

- Optional edge-cache reads and writes have 200 ms deadlines. Stalled cache
  operations, abort-ignoring transports, incomplete response bodies and stalled
  cancellation no longer hold a shared request slot indefinitely. Late responses
  cannot overwrite a recovered in-memory result.
- Connection failures and HTTP 408/500/502/503/504 receive at most one retry within
  the original eight-second upstream budget. Valid `Retry-After` delays are
  respected when affordable. Redirects, rate limits, authorization failures,
  invalid UTF-8 and oversized bodies are not retried. Failed revalidation still
  never serves expired cached warnings as current.
- National/SACHET detail workers reuse four slots, and WMO reuses three. One slow
  document cannot block all the next documents. WMO's own deadline now retains
  already verified bulletins while disclosing failed and unchecked documents;
  caller cancellation still rejects, and zero verified candidate documents is
  still a failure.
- The live-check command now records elapsed time and individual failed-source
  details, and accepts `--base-url=https://stormsignal-weather.pages.dev` for the
  hosted API. Its strict requirement that every configured source succeed is
  unchanged.

`npm run check` passed **308 tests**, TypeScript, the production browser build,
embedded Worker checks and Pages artifact checks on macOS with Node **26.13.0**.
This adds 19 tests to the previous 289-test baseline. Focused transport and adapter
tests cover cache/transport/body stalls, recovery, shared readers, retry bounds,
`Retry-After`, concurrency limits, queue cancellation, partial results and optional
translation deadlines. The changed TypeScript files pass Prettier and
`git diff --check`. A clean install reported zero known dependency vulnerabilities.
Repository CI separately targets Node 22.

The real local production-artifact check at **03:57 UTC** returned:

| City          | Elapsed | Observed provider result                                        |
| ------------- | ------: | --------------------------------------------------------------- |
| San Francisco |  1.04 s | NWS passed; four active records at that instant.                |
| Kolkata       |  1.06 s | IMD district and SACHET regional checks passed.                 |
| Jakarta       |  2.39 s | BMKG direct and WMO supplementary checks passed.                |
| Manila        |  8.00 s | WMO passed; direct PAGASA timed out. Partial response retained. |

The strict live command therefore **exited 1**. PAGASA's direct CAP origin also
failed standalone connection probes and the existing hosted check; this is an
upstream availability limitation, not a claim that this change restored PAGASA.
The [WMO authority registry](https://alertingauthority.wmo.int/authorities.php?recId=127)
still lists the configured CAP feed; no verified replacement endpoint was found.
The existing PAGASA NCR authority page remains the fallback link. Raw local
results, including the failure, are in
[the live-check record](evidence/provider-reliability-2026-11-13/local-live.json).

In the local production browser, Manila's forecast remained usable while its
warning request completed with WMO available, PAGASA unavailable, **1/2 retrieved**,
and explicit incomplete-coverage text. The source panel retained the authority
links and disabled page notifications for incomplete coverage.
[Browser evidence](evidence/provider-reliability-2026-11-13/manila-sources.jpg).
Switching to Kolkata and Jakarta loaded their forecasts and **2/2 retrieved**
source status. No browser console errors or warnings appeared in these flows.
These tests establish bounded application behavior; they do not certify future
provider uptime or complete warning coverage. Earlier deployment and browser
records below describe their own dated releases.

## Submission review — 13 November 2026

Reviewed the client data/storage boundaries, warning gateway, offline recovery,
build configuration and existing tests at baseline `6eb94d8`. This pass fixes:

- Saved places now validate bounded IDs, names, countries, country codes,
  optional region names and timezones. Invalid entries are skipped independently;
  valid entries survive, country codes are normalized and unknown fields are
  discarded. The parser bounds the stored input and retains the eight-place limit.
- NWS responses with more than 100 records or another page are explicitly
  incomplete. They retain the official-source link and use the existing partial
  coverage behavior, including disabling page notifications. Pagination links
  are not followed automatically.
- Outgoing NWS links reject embedded credentials and nonstandard ports, in
  addition to the existing HTTPS and government-domain checks.
- `npm test` uses Node's `--import tsx` loader directly, avoiding the `tsx` CLI's
  extra IPC listener in restricted execution environments.
- `fast-xml-parser` is pinned to **5.12.0**, the patched version for
  [GHSA-474x-hrwr-fgx4](https://github.com/advisories/GHSA-474x-hrwr-fgx4).
  The advisory concerns the non-default `stopNodes` option, which these adapters
  do not enable. The dependency and lockfile were updated together.

Four regression tests failed against the previous implementation and passed
after the fixes; a fifth verifies the complete 100-record boundary. On Linux with
Node **24.22.1**, `npm run check` passed **289 tests**, TypeScript, the production
browser build, embedded Worker checks and Pages artifact checks. `npm audit`
reported **zero known vulnerabilities** after the update. This is a point-in-time
registry result, not a guarantee about undiscovered issues. Node 22 remains the
repository's CI target.

The opt-in live warning check at **03:33 UTC** passed for San Francisco (four
active records), but failed for Manila and Jakarta because at least one source
was unavailable, and for Kolkata with HTTP 503. A subsequent source-level check
retrieved WMO's Manila result and IMD Kolkata successfully while direct national
requests timed out. These observations do **not** establish that all live
integrations are healthy; preserve the partial/unavailable states and use the
official authority links. No mocked result was substituted for a live failure.

The production preview served locally, but this session's separate browser could
not reach its loopback address. No new visual, mobile or device-offline browser
verification is claimed. This review also does not redeploy the hosted website;
earlier screenshots and deployment records below refer to their dated releases.

## Reliability and rendering review — 7 November 2026

- **281 deterministic tests passed.** The integrated `npm run check` also passed TypeScript, the production browser build, embedded Worker checks and Cloudflare Pages artifact checks. The production-dependency audit reported **zero known vulnerabilities** at the time of this review; it does not establish that every dependency is free of undiscovered vulnerabilities.
- Fixed a cached-dashboard recovery gap: the navigation deadline now covers the complete, bounded HTML body rather than just response headers. An origin that sends headers and a partial document, then stalls, can no longer hold the installed dashboard indefinitely. Aborted transfers release both response branches. When a cached dashboard replaces an HTTP error response, its unused body is cancelled; without a cache, that original response remains readable. Existing cache, redirect and optional-download behavior remains covered by regression tests.
- CAP namespace validation now checks the alert root and the fields consumed by the adapter, preventing extension elements with matching local names from being interpreted as official CAP values. This is a focused validation boundary, not a complete CAP schema validator. Other fixes retain heavy-thunderstorm code **97** in forecasts and model signals, cancel rejected or oversized weather/GDACS bodies without hiding the original error, and reject impossible GDACS calendar dates even when an explicit timezone is present. Code 97 is documented by [Open-Meteo](https://open-meteo.com/en/docs); application screening levels remain distinct from official warning severity.
- Forecast inspection now reuses stable series, chart geometry and timestamp labels when only the selected hour changes. Date formatting uses a bounded 64-entry cache; tests retain timezone precedence, daylight-saving distinctions, invalid-zone fallback and option immutability, and verify eviction instead of allowing unbounded growth.
- An alternating **Node React SSR benchmark** of the actual forecast component used 40 warmups and 200 samples per version, with 24 visible hours, 72 supplied hours and two comparison models. Median rendering time changed from **1.271 ms to 0.425 ms**; p95 changed from **2.816 ms to 1.118 ms**. The complete rendered HTML matched exactly. [Raw measurements and method](evidence/review-2026-11-07/forecast-render.json) identify the baseline commit and Node version. These results measure server-side rendering on the test machine, not browser paint, INP, mobile performance or client-side memo reuse.
- The opt-in live warning check passed for **San Francisco, Manila, Kolkata and Jakarta** through the local production artifact at **7 November 2026, 10:58 UTC**. San Francisco returned two active warnings. The other three returned zero matched unexpired warnings with their partial/limited coverage retained; their configured direct and supplementary sources were available. These counts describe that check, not current conditions, complete warning coverage or an all-clear. This local check does not certify the hosted edge runtime.
- A browser check used an installed production dashboard against a controlled local origin that returned HTTP 200 HTML headers and a partial body, then stalled. The cached dashboard reloaded in **3.23 seconds**, and the server recorded the connection closing after **3.008 seconds**. A saved Chennai briefing remained readable with **CURRENT STATUS UNKNOWN**. The app was in **Offline only** while internet connectivity remained enabled: this was a stalled-origin recovery check, not a device radio-off test. [Browser capture](evidence/review-2026-11-07/offline-fallback.png).
- Additional local production browser checks confirmed that reconnecting in Data saver loads a fresh forecast. Rainfall with End selected the final hour, while Wind with Home selected the first, retaining units and timezone labels. With the exact hourly table expanded at **390 × 844** and **320 × 740**, document scroll width matched the viewport width. Escape closed the mobile drawer and returned focus to **Open navigation**. No browser errors or warnings appeared in these flows. Full workspace also loaded both comparison models; the 72-hour control and End key selected the final hour, showing unavailable model readings explicitly. Himawari imagery displayed its capture time and source attribution.

- The optional GDACS report panel exposed a provider limitation: the same official API returned valid JSON to the Node adapter but HTTP 200 HTML to requests with ordinary browser headers. Separate real-provider reads produced 182 unique events from two bounded pages (200 records, truncated history). Explicit HTML/XHTML responses are now cancelled before reading their bodies and display a specific provider-page error; recovery and partial second-page results have regression coverage. The official-source link remains available. This is not a passing live browser report integration, and no proxy or disguised request headers are used to evade the provider response.

- Published the reviewed source commit `3e63483` to [Cloudflare Pages](https://stormsignal-weather.pages.dev), deployment `9f40d63c`. Production HTML, service worker, emergency kit, critical JavaScript and CSS matched the tested artifacts byte-for-byte. Hashed assets retained immutable caching, the service worker returned `no-cache`, and invalid warning coordinates returned HTTP 400.
- Hosted international warning checks passed at **7 November 2026, 11:12 UTC**, with both configured sources available for Manila, Kolkata and Jakarta. The direct NWS control returned two active San Francisco warnings. An initial hosted check reported a partial-source failure for Manila and Jakarta; a bounded retry recovered. [Initial and retry results](evidence/review-2026-11-07/hosted-alerts.json) preserve both outcomes rather than claiming uninterrupted provider availability.
- Live browser verification loaded the forecast, model comparisons, Himawari capture metadata and the clearer GDACS provider-page fallback. A Chennai briefing, including saved regional warning text, survived a reload in Offline only and remained explicitly historical. Mobile rainfall selection and End-key inspection worked at **390 × 844** without page overflow; no console errors or warnings were observed. [Desktop capture](evidence/review-2026-11-07/live-desktop.png) and [mobile capture](evidence/review-2026-11-07/live-mobile.png) show that verification snapshot, not current weather.
- PR [#6](https://github.com/TARUNTEjjjj/stormsignal/pull/6) merged after clean Node 22 CI, and its merge commit passed CI again. Repository visibility was verified private; the public Pages site remains available.

Historical results below describe their own releases. This review does not certify capacity, universal device behavior, complete warning coverage or emergency readiness.

## Submission-readiness audit — 7 November 2026

- **259 deterministic tests passed after a clean `npm ci`.** `npm run check` also passed TypeScript, the production browser build, embedded Worker checks and Cloudflare Pages artifact checks. The full lockfile audit reported **zero known vulnerabilities** at the time of this audit; this is not a guarantee against undiscovered vulnerabilities.
- Reviewed and integrated the six fixes in PR #3: retained same-place data during refresh/failure, independent warning-source deadlines, XML character references, readable gateway/satellite errors and mobile drawer focus containment. Additional fixes enforce the satellite metadata limit on streamed UTF-8 bytes, honor cancellation before cached results, cancel unread error bodies, distinguish saved hourly timezone labels, and suppress page notifications during failed or pending warning refreshes.
- Seven new regressions exercise the satellite boundary/cancellation cases and the actual forecast component's empty state, timestamp-aligned model values, missing readings, gust column, daylight-saving labels and unique SVG/accessibility identifiers. Permission-granted desktop notification delivery was not browser-tested; its eligibility guards were reviewed.
- The opt-in live warning check passed for **San Francisco, Manila, Kolkata and Jakarta** using real upstream responses through the local production artifact at **6 November 2026, 18:27 UTC**. San Francisco returned two active bulletins; the other three returned zero matched unexpired bulletins, with their limited/partial coverage preserved. These counts describe that instant, not present conditions or an all-clear. This check does not certify the hosted edge runtime.
- Browser review used the production preview, with live retrieved data. Temperature/rainfall/wind, Home/End hour selection, 24/72-hour availability, exact hourly values, model overlays and missing model values were checked. Himawari imagery loaded with provider capture times and attribution. Keyboard search selected Sydney and removed the previous place's data while its requests loaded.
- At **320 × 740, 390 × 844, 768 × 1024 and 1440 × 1080**, no page-level horizontal overflow was observed. The expanded wide table scrolls within its own labelled region. At mobile size, Shift+Tab from the first drawer link reached the closed final disclosure, Tab wrapped to the first link, and Escape restored focus to the navigation opener.
- A saved Kolkata briefing remained readable with **CURRENT STATUS UNKNOWN** in Offline only, while online search was disabled. Saved hourly rows displayed timezone suffixes, and the text-download action completed. This was an application-mode check with the internet connected; it did not repeat the historical origin-outage test. No browser console errors were observed in these flows.
- Repository setup now declares Node 22 in `.nvmrc`, provides a shared `npm run check` for local/CI verification, and separates opt-in live-provider checks. The README, architecture/deployment notes, contribution guide, PR template and UI acceptance checklist give reviewers a reproducible route through the implementation. Dependencies were not upgraded in this audit.

Scope: StormSignal only. The checks above support a reviewable portfolio submission, not an assertion that all possible bugs are absent. Comprehensive assistive-technology, browser/device, load and emergency-readiness testing remain outside this audit.

## Frontend showcase — 6 November 2026

- **239 deterministic tests passed.** Five new forecast-geometry checks cover timestamp joins, null/missing-hour gaps, single points, model-aware scales and pointer selection. TypeScript and the production build passed, including embedded Worker and Pages routing/API/artifact checks.
- Browser review used the local Vite build with live retrieved provider data. Temperature, rainfall and wind controls changed units/readings; ArrowRight and End changed the hour; pointer inspection selected the corresponding timestamp. Exact hourly values and the retained gust column were checked. Full workspace exposed 72 hours and two model series; missing model values remained unavailable.
- Data saver keeps the existing compact data request and disables the unavailable 72-hour control. The SVG chart and atmosphere illustration add no third-party graphics service or package dependency. Maps and report chunks remain optional in the production precache: two essential JS/CSS assets, four optional map/report assets.
- At **1440 × 1080** and **390 × 844**, no page-level horizontal overflow was observed, including the expanded exact-data table on mobile. Mobile navigation opened with focus inside the drawer; Escape restored focus to its opener. Keyboard city search selected Sydney and cleared the prior city's values while new data loaded.
- A Chennai briefing saved successfully and remained explicitly **SAVED COPY · CURRENT STATUS UNKNOWN** in Offline only, while online search and refresh were disabled. This was an application-mode check with the network still connected, not a radio-off test.
- Screenshots: [desktop dashboard](images/dashboard-desktop.jpg), [mobile forecast](images/dashboard-mobile.jpg). These capture one data snapshot, not current weather or proof of complete provider coverage. Decorative atmosphere artwork is separate from measured/forecast graphics.
- Reduced-motion styles were inspected in code; no new animation is introduced. Comprehensive assistive-technology testing and a full browser/device matrix were not performed in this iteration.

The sections below are historical release records. Their test totals, supported regions and limitations describe those versions; they do not override the current coverage documentation.

## Direct local warning feeds — 1 November 2026

- **227 deterministic tests passed**, including direct PAGASA Atom and BMKG RSS/CAP parsing, hostile XML/URLs, geographic matching, cancellation across sources, partial outages, duplicate identifiers, Kolkata district scope/timezones/onset/expiry, source-check validation and historical direct-source links. TypeScript, production build and Worker artifact checks passed.
- Real checks against the production Worker artifact at **31 October 2026, 21:35 UTC** returned both direct and supplementary sources successfully for Manila, Kolkata and Jakarta. Manila verified 20 selected PAGASA documents and explicitly disclosed 31 unchecked older entries. Jakarta verified all eight listed BMKG documents. Kolkata's public IMD rolling RSS had no Kolkata entry; its SACHET West Bengal regional feed also responded. All three returned zero matched unexpired bulletins in these limited feeds, not an all-clear. San Francisco's NWS control still returned its Coastal Flood Advisory.
- A real BMKG positive control at Labuan returned one English thunderstorm bulletin linked directly to BMKG. Its indexed WMO copy had a regenerated identifier; exact issuer/text/area/validity deduplication retained one direct bulletin. A province source document containing 197 polygons exposed the former 100-polygon parser limit; the limit is now 256 within the unchanged 256 KB document bound, with a regression test.
- PAGASA's newest retrieved bulletin was already expired at verification time. Its positive parsing/matching control was an explicitly historical replay of real source text at 31 October 09:10 UTC; this was not represented as a current warning.
- Desktop browser checks exercised all three new direct-source panels, expandable per-source status, original issue times and scope limits. At **390 × 844**, all three locations and source-check panels worked without page-level horizontal overflow; no browser console errors were observed. A Kolkata briefing saved the combined district/state scope and remained readable in Offline only with CURRENT STATUS UNKNOWN. This was an application-mode check with internet still available, not a radio-off test.
- Newer IMD JSON APIs returned authentication requirements and were not bypassed. The public documented district RSS is intentionally partial; no warning/expiry/severity is fabricated when an entry is absent or malformed. Independent source failures are tested using fixtures; future upstream availability and complete city coverage are not guaranteed.

## Four-city official-alert audit — 1 November 2026

- **184 deterministic tests passed**, including new San Francisco NWS point/validity, Kolkata West Bengal regional scope, PAGASA empty-index limits, and BMKG official-language matching regressions. TypeScript, production build and executable Worker artifact checks passed.
- Fixed future-effective NWS/international client records being accepted as active. Current warnings whose hazard onset is in the future remain valid; an issue time, effective time and hazard onset have different meanings.
- Real-provider checks of the new production Worker artifact at **31 October 2026, 21:24 UTC** succeeded for all four cities: San Francisco returned one NWS Coastal Flood Advisory; Manila/PAGASA and Jakarta/BMKG returned zero point-matched bulletins in the limited WMO index; Kolkata returned zero unexpired bulletins in the West Bengal regional SACHET history (latest feed bulletin 14:17:39 UTC). Empty results do not establish safety or complete local coverage.
- A real BMKG positive control at Labuan, Indonesia returned its official English thunderstorm warning with matching original identity, times, severity and polygons. The new adapter retains original Indonesian text on missing, mismatched or slow English copies. A regression prevents losing two distinct original information blocks with identical geometry and validity when a translation contains only one.
- The existing live Site and the updated local interface were checked for all four location selections. Direct local NWS, PAGASA NCR, IMD Kolkata and BMKG Jabodetabek links were verified against the authorities' pages. At **390 × 844**, all four city selections and source links worked without page-level horizontal overflow. Page notifications remained disabled for partial feeds and Data saver.
- Added an explicitly opt-in live smoke command: build, then `node --import tsx scripts/check-live-alerts.ts --live`. It checks real public providers and the local production Worker artifact, fails on unavailable/stale/invalid results, and does not require a nonempty warning list. It is separate from deterministic CI and does not certify Cloudflare edge behavior or future provider availability.

## San Francisco and risk-study locations — 1 November 2026

- Added San Francisco as a regular shortcut and Manila, Kolkata and Jakarta as city examples from the top three countries in the 2026 WorldRiskIndex. The interface labels national rank, explains the scope and links the source; it does not rank the cities or feed the index into live warning calculations.
- Live geocoding and compact forecasts returned the expected country, coordinates, timezones, current temperatures and 24 hourly points for all four cities. Initial provider HTTP 503 responses recovered on one bounded retry.
- Browser checks covered San Francisco, Manila and Kolkata on desktop; the ranking explanation expanded correctly. At 390 × 844, the new group remained accessible without page-level horizontal overflow; selecting Jakarta closed navigation and loaded its Asia/Jakarta forecast.
- All 169 deterministic tests, TypeScript, production build and Worker artifact checks passed.

## International official warnings — 1 November 2026

- **169 deterministic tests passed**, including CAP XML/status/namespace validation, timezones, expiry/cancellation/update references, exact geographic matching, incomplete-source responses, bounded requests, 200/304 ETag handling, failed revalidation, unsafe URLs, and India/global offline snapshots. TypeScript, production build and executable Worker artifact checks passed.
- Existing static content was moved into a self-contained Worker on the same Site identity. Asset/HTML/offline aliases and conditional reads passed; source/config paths return 404. The warning endpoint returns `no-store`; the service worker does not intercept warning API requests. Dependency installation/audit reported zero vulnerabilities.
- Live India adapter checks: Mumbai/Maharashtra, Bhubaneswar/Odisha and Chennai/Tamil Nadu returned readable regional feeds. All had zero unexpired bulletins in the bounded source history at check time. This does not establish an absence of current warnings. Chennai's latest publication was 26 October; the interface explicitly displays its age and unverified coverage.
- Live global checks: Glen Innes, Australia returned an Australian Bureau of Meteorology warning with source issue/expiry times; London returned a limited empty result; Tokyo was explicitly unsupported because no matching operating official CAP source was listed. These representative checks do not certify every source/country.
- A live WMO WFS timestamp differed from its original CAP timestamp by eight hours. The adapter uses only the original CAP times for displayed validity; a fixture locks this behavior in. Issuing agency text and canonical WMO copies remain attributed.
- Browser checks: Chennai, Mumbai and Odisha showed the correct regional scope and IMD links. Mumbai's regional metadata saved in a historical briefing. Miami still displayed its live NWS rip-current and coastal-flood products at check time. No browser errors were reported in these flows.
- Glen Innes's live BOM warning displayed its original headline, instructions and issuer and saved successfully. At 390 × 844, the warning panel fit the viewport without horizontal overflow. With the local Worker stopped, the installed dashboard reloaded in Offline only, both international/regional saved briefings remained readable, and the offline emergency kit opened. External internet remained available: this was an origin-outage check, not a radio-off device test.
- The first hosted check exposed Cloudflare's unsupported `redirect: error` mode. Requests now use `manual` and reject 3xx status codes without following them; the HTTP regression verifies this supported mode and rejection. Provider errors remain actionable in the UI without leaking runtime diagnostics.

## Earlier weak-signal and offline baseline

## Quick locations and global search — 1 November 2026

- Added Mumbai (Maharashtra, India) and New York City (New York, United States), using coordinates and timezones returned by the configured place-search provider. Quick locations and saved places are separate so eight saved entries cannot displace defaults.
- Live adapter checks succeeded for Mumbai, New York City (returned as “New York”), Sydney, São Paulo, Cape Town and Reykjavik. Each returned the expected country/timezone, a usable current temperature and 24 hourly forecast points. This is a representative sample, not exhaustive validation of every location.
- Forecast requests have no country allowlist. Place search returns up to eight indexed matches; an unlisted place may require a nearby city or a map point in Full workspace. Automatic NWS warning coverage, satellite viewing limits and online/offline requirements remain separate constraints.
- Browser checks covered both new shortcuts, a saved place remaining separate, Sydney search/selection and an unknown-place empty result. At 390 × 844, New York City selection closed navigation and loaded the forecast without page-level horizontal overflow. All 106 tests and the production build passed.

Verified 1 November 2026 (Asia/Kolkata). These are observed software checks, not a guarantee of emergency readiness or weather accuracy.

## Automated checks

- **106 deterministic tests passed**, including provider normalization, compact-vs-full forecast requests, request policy, warning freshness, bounded historical snapshots, multibyte storage limits, corruption/quota failure, safe exports, emergency-kit state, and service-worker routing/install/update behavior.
- TypeScript check and Vite production build passed. Dependency audit reported zero vulnerabilities in both production dependencies and the full lockfile at verification time.
- Essential application JS/CSS: approximately **103 KB gzip** as reported by Vite. Four optional map/report assets (approximately **62 KB gzip**, before remote tiles and feeds) are excluded from initial precaching. Transfer totals depend on host compression, headers, cache state and provider responses.
- Generic self-contained emergency kit: **25,163 bytes**. No remote assets or background network APIs; static action cards remain readable without JavaScript.
- Production uses a clean-URL redirect from `/offline.html` to `/offline`. This exposed an incompatible cached redirect response during document navigation. The worker now strips same-origin document redirect history while preserving body/status/headers; three regressions use an actual local HTTP redirect response.
- Worker tests cover atomic failed installation, a hanging dashboard request falling back after three seconds, disabled/quota-limited caching, previous-build assets, and exclusion of external APIs/private/query-bearing URLs.

## Browser verification

- Live Chennai compact forecast loaded; a saved 24-point briefing retained original retrieval/model times and explicit unsupported India-warning coverage.
- Offline only removed live weather panels, disabled online search/refresh and retained the saved briefing with **CURRENT STATUS UNKNOWN**.
- With the local production server stopped, the cached dashboard reloaded and the emergency kit opened. The dashboard was explicitly in Offline only. External connectivity remained available to the browser; this was an origin-outage check, not a device radio-off simulation.
- Test emergency-plan fields, including Tamil text, and a checklist selection persisted across reload with the origin stopped.
- Downloaded a populated HTML kit through the actual UI. The browser automation security policy blocks `file://` navigation, so reopening that downloaded file was **not** browser-verified. Embedded plan restoration, escaping, local-save precedence and storage denial are covered by deterministic kit tests. Test the downloaded file on each intended mobile file viewer and keep PDF/paper as a fallback.
- Inspected kit and dashboard at **390 × 844**. No page-level horizontal overflow was reported; mobile navigation exposed the saved-briefing destination. Desktop field-mode layout was inspected at 1280 pixels.
- Updated the cached application with a new production build and confirmed the cache-readiness status.
- On reconnection and reload, the full map/report tools loaded. GDACS reports and satellite capture metadata were displayed; missing satellite tiles were explicitly labelled as missing data. A live Miami forecast and two NWS bulletins were saved, then read in Offline only with unverified historical labels.
- Compact forecast times include dates and zone labels to distinguish midnight and repeated daylight-saving hours; a regression test covers the New York clock change.
- Stopped the origin before the first optional map/report download, then selected Full workspace. Both optional tools displayed isolated errors; saved briefings and the connection controls remained usable. Switching to Data saver restored essentials without an app-wide crash.

## Limits

No emergency drill, live evacuation-routing test, capacity certification, guaranteed warning delivery, comprehensive assistive-technology audit or complete device/browser matrix has been performed. Geolocation and notification permissions were not enabled. Browser storage may be evicted; new weather and warnings always require a connection. Integrated alerts remain limited to NWS coverage for locations with resolved country metadata. Named-city selection is needed to establish that coverage; India warning integration is not added by this release.

---

# Initial release verification

Verified 31 October 2026 (Asia/Kolkata). These are recorded checks, not guarantees of weather accuracy or emergency readiness.

## Automated

- 55 deterministic tests passed: provider validation, missing/out-of-range numbers, rate-limit/failure handling, cancellation, NWS validity filtering, hazard screening, satellite timestamps and gaps, GDACS distance/pagination/partial feeds, local storage parsing, chart gaps and offline cache routing.
- TypeScript check and Vite production build passed.
- Dependency audit: zero reported vulnerabilities at the time of verification. This can change as new advisories are published.
- Production service worker contains the build's hashed JS/CSS asset paths for first-visit precaching. It only handles known same-origin shell routes and assets; external weather, satellite tiles, private paths and query-bearing requests are excluded.

## Live data and browser flows

- Chennai: actual forecasts, both comparison models, air-quality estimates and timestamped Himawari infrared tiles loaded.
- City search: multiple Miami results returned; selecting Florida changed the displayed location and data.
- Miami: live NWS Rip Current Statement and Coastal Flood Advisory displayed with the issuing source, message validity and official instructions. Those bulletins are time-specific; they are not claims about current conditions when this document is read later.
- Forecast controls: rainfall and 72-hour comparison selected successfully.
- Satellite: daily global imagery in London loaded with metadata-derived dates; keyboard slider changed from the newest composite to an earlier date.
- Map lifecycle: fixed a Leaflet event-cleanup crash, then verified switching locations, data-saver mode, reload and explicit map re-enabling.
- Regional GDACS reports: real India reports displayed; switching from 1,000 km to 250 km produced an explicit no-matching-reports message without implying safety.
- Origin-offline smoke test: after successful caching, stopped the local production server and reloaded both the preparedness page and dashboard successfully. External provider network access remained enabled; this was not a full device-offline simulation. Fixed cache matching for public shell assets carrying transport-only Vary headers.
- Local persistence: saving a place and reloading data-saver preferences worked. Checking a preparedness item persisted across reload, then was unchecked to remove the test state.
- Responsive inspection: desktop 1,440×1,000 and mobile 390×844 layouts, including mobile navigation, were exercised in the in-app browser.

## Limits of verification

No emergency-drill validation, load/capacity certification, guaranteed notification-delivery test, comprehensive assistive-technology audit, or complete device/browser matrix has been performed. Browser geolocation and notification permission were not enabled during testing. Unit tests simulate unavailable providers; they cannot guarantee future third-party service behavior. India local warnings are not integrated; official IMD links and separate GDACS regional reports do not replace them.
