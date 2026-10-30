# StormSignal

[Open the live website](https://stormsignal-weather.gardenroot512.chatgpt.site) · [Verification notes](docs/verification.md)

Weather with evidence. An open-source weather workspace that puts forecasts, satellite imagery, model disagreement, and official warning coverage in one view.

StormSignal is intended for public situational awareness and learning. It does not issue official warnings, certify safe routes, or replace emergency instructions. No data is not the same as no danger.

## What makes it different

- **Inspect the sky:** timestamped NASA GIBS satellite layers, recent geostationary frames where coverage permits, and a global daily true-color view. Images represent their displayed observation time, not an instantaneous view of a street.
- **Compare rather than conceal disagreement:** ECMWF IFS and NOAA GFS model forecasts. Differences between two models are not calibrated forecast probabilities.
- **See the evidence:** forecast-based hazard indicators are separate from official alerts; imagery capture times and unavailable feeds remain visible.
- **See regional context:** recent GDACS cyclone, flood and wildfire reports filtered by distance to their representative points. Overall humanitarian-impact tiers remain separate from local warnings and hazard boundaries.
- **Prepare for disruption:** responsive and low-bandwidth views plus a standalone printable preparedness checklist at `/preparedness.html`.
- **Stay aware while browsing:** opt-in page notifications for retrieved NWS alerts. They require the page to stay open and are not a background emergency-warning service.
- **Keep control:** no account, advertising, app analytics, or API key required for the current public-data integrations. Saved preferences remain in the browser. Providers still receive network requests; see [privacy](docs/privacy.md).

## Run locally

Use Node.js 22.12 or newer (Node 24 LTS also works with the build toolchain).

```sh
npm ci
npm run dev
```

Open the URL printed by Vite. The app requires an internet connection for new forecasts, alert retrieval and map tiles. A downloaded or printed preparedness sheet remains useful without a connection.

The production build generates a versioned service-worker asset list. On the first online visit, installation precaches the app shell, hashed JavaScript/CSS assets and preparedness page. Offline reopening depends on that installation completing successfully and browser storage being retained; a full device-offline smoke test has not yet been recorded. No cache provides fresh weather or offline map imagery. The checklist uses system fonts and no external assets. The main dashboard uses Google Fonts with system-font fallbacks.

```sh
npm test          # deterministic unit tests
npm run build    # TypeScript check and production bundle in dist/
npm run preview  # preview the production bundle locally
```

Tests use fixtures and mocks where appropriate. Passing them does not prove that a third-party feed is presently reachable or that a forecast is accurate. Provider responses and visual flows also need live verification before each release.

## Architecture

The app is a static React + TypeScript application built with Vite. Leaflet renders the map. Browser data adapters request public endpoints directly; there is no StormSignal account database or secret-bearing server in this release.

| Area | Files |
| --- | --- |
| Provider validation, requests and data normalization | `src/data.ts`, `src/types.ts` |
| Transparent forecast-based hazard indicators | `src/risk.ts` |
| Satellite layer selection and available observation times | `src/imagery.ts` |
| Interactive satellite map and alert geometries | `src/components/WeatherMap.tsx` |
| GDACS report retrieval and local distance filtering | `src/disasters.ts`, `src/components/DisasterWatch.tsx` |
| Offline-ready preparedness content | `public/preparedness.html` |
| Unit tests | `tests/` |

The map uses source-provided alert geometry when available. Some valid official alerts have no polygon; a missing outline does not invalidate their text. Location search results and forecast grids can differ from exact GPS coordinates.

Supported alert feeds are checked every minute while the dashboard is visible and online. Weather panels refresh every 15 minutes, with bounded in-memory caches; returning to the visible dashboard requests another refresh. Satellite metadata has its own refresh cadence. Fetch time is not a provider model-run or observation time.

GDACS regional reports refresh every 10 minutes while visible and online. The adapter requests a recent 14-day window for cyclone, flood and wildfire reports at all three impact tiers, capped at two pages of 100 global records. The UI identifies truncated/partial snapshots, offers 250 / 1,000 / 5,000 km search distances, and displays up to four matching reports. Distance filtering happens in the browser, not at the provider. Distance to a representative point is not the extent of an affected area.

## Coverage and limits

| Feature | Coverage | Important limit |
| --- | --- | --- |
| Forecasts and model comparison | Global forecast grids via Open-Meteo | Modeled estimates, not local instrument observations; resolution and update times vary. |
| Air quality | CAMS model output via Open-Meteo | Regional/global grid estimates; not a street-level air sensor. |
| Near-real-time satellite | Supported geostationary viewing areas | Capture delay, limb distortion, missing frames and viewing limits apply. |
| Daily true-color satellite | Global NASA GIBS product | Clouds, polar night, orbital gaps and processing delays affect availability. |
| In-app official warnings | United States NWS coverage | Other regions are explicitly marked unsupported and linked to an official service. |
| Regional disaster reports | Retrieved GDACS cyclone, flood and wildfire reports | Recent reports, not a complete global warning feed; 200-record retrieval cap and representative-point distance limits apply. |
| Preparedness checklist | General household preparation | Local authorities' current instructions take precedence. No live shelter or evacuation routing. |

See [data sources and licensing](docs/data-sources.md) and [imagery details](docs/imagery.md). The app cannot guarantee notification delivery, availability, or detection of every hazard. Do not rely on it as your only warning channel.

### Hosting and traffic

`npm run build` produces static files that can be hosted over HTTPS. Direct-browser requests depend on the providers' CORS policies. Open-Meteo's free API is for **non-commercial use** and currently requires fewer than **10,000 calls/day**, **5,000/hour**, and **600/minute**, with limits applied by IP and application. An open-source code license does not remove those service limits. Do not assume this deployment supports an arbitrary number of simultaneous users.

For a commercial or high-traffic deployment, arrange suitable provider access, review map tile policies, implement an appropriate server cache and rate limits, and measure capacity. Keep paid API credentials server-side; Vite environment variables are included in the browser bundle. This repository contains no paid credentials.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Improvements to alert coverage, accessibility, provider resilience and documented verification are especially useful. Please include evidence for data and safety claims. Work is published using real commit times and attributable source changes; third-party notices must be preserved.

## License

Original application code is available under the [MIT license](LICENSE). Weather data, imagery, map tiles, provider names and third-party libraries retain their respective terms and attribution requirements. MIT licensing of the code is not a redistribution license for every displayed dataset.
