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
