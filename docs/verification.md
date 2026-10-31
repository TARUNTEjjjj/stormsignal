# Release verification

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
