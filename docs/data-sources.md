# Data sources and interpretation

Provider integrations reviewed 31 October 2026; offline-mode additions reviewed 1 November 2026. Providers can change availability, coverage and terms; verify them before release or commercial use.

## Forecasts, models and air quality

[Open-Meteo's forecast API](https://open-meteo.com/en/docs) supplies the weather series. Its current conditions are model estimates, not direct readings from an instrument beside the user. Times in the data layer are epoch milliseconds; the display uses the forecast location's timezone.

The comparison uses [ECMWF IFS](https://open-meteo.com/en/docs/ecmwf-api) and [NOAA GFS](https://open-meteo.com/en/docs/gfs-api) products available through Open-Meteo. Differences show model disagreement; two deterministic forecasts do not define a calibrated probability distribution. Values interpolated onto an hourly grid do not acquire finer physical resolution.

[CAMS air-quality output](https://open-meteo.com/en/docs/air-quality-api) is also modeled. Grid averages cannot establish the precise exposure of a person at a particular street or indoors. Preserve CAMS and Open-Meteo attribution when reusing these values. Place search uses [Open-Meteo geocoding](https://open-meteo.com/en/docs/geocoding-api), based on GeoNames.

[Open-Meteo's terms](https://open-meteo.com/en/terms) distinguish CC BY 4.0 data licensing from access to its free, non-commercial API. Current request ceilings are under 10,000/day, 5,000/hour and 600/minute. Ads, subscriptions or greater traffic require a suitable service arrangement; free API capacity is not a deployment guarantee.

Data saver uses the same normalization with `forecast_hours=24`, current-condition variables, and no daily series. Full workspace requests the full seven-day forecast and comparison feeds. Missing variables remain missing rather than becoming zero.

## Official alerts

The [U.S. National Weather Service API](https://www.weather.gov/documentation/services-web-api) provides active, point-specific U.S. warnings. The app preserves authority text and expiration, excludes cancelled/expired entries, and uses supplied geometry where available. Some warning products have no polygon in the response.

Outside supported U.S. coverage, the app does **not** infer an all-clear from an empty feed. India links to the [India Meteorological Department](https://mausam.imd.gov.in/). Other regions link to the [WMO Severe Weather Information Centre](https://severeweather.wmo.int/). These links are not an integrated global warning feed. A map point or device coordinate without a resolved country is also marked unsupported; choose a named city to establish regional feed coverage.

Full workspace checks supported alerts once per minute while visible and online. Data saver uses deliberate refreshes with no periodic polling; offline mode makes no provider checks. A check older than two minutes is no longer presented as current. Historical saved briefings preserve source times and always require current verification. This is a retrieval interval, not a promise that an authority publishes new data every minute. Optional page notifications are limited to an open page and supported browsers; there is no server push-warning subscription.

Forecast-derived hazard indicators are application heuristics. They are not authority-issued alert colors, evacuation advice or warnings. Their thresholds live in `src/risk.ts`; they should remain inspectable and tested. An absence of indicators cannot establish safety.

## Regional disaster reports

The separate regional panel uses the **Global Disaster Alert and Coordination System, GDACS**, through its [official API](https://www.gdacs.org/gdacsapi/swagger/index.html). The [GDACS quickstart](https://data.gdacs.org/Documents/2025/GDACS_API_quickstart_v1.pdf) documents free access, attribution and pagination. Review its linked [terms of use](https://www.gdacs.org/documents/2025/GDACS_Terms_of_use_Mar_25.pdf) when reusing the reports.

StormSignal requests recent tropical-cyclone, flood and wildfire reports, including red, orange and green overall impact assessments, from `https://www.gdacs.org/gdacsapi/api/Events/geteventlist/SEARCH`. Retrieval is limited to two pages of 100 global records; the UI discloses capped or partial retrieval. Repeated event episodes are deduplicated. A 14-day report window can include periods that have already ended; ongoing impacts require verification at the source.

The browser computes distances to event representative points and offers 250, 1,000 and 5,000 km search ranges. These ranges are display filters, not hazard boundaries. Up to four matching reports are shown with official report links. The panel does not place artificial danger circles on the map, route evacuation, or declare a selected place safe. GDACS impact colors describe overall potential humanitarian impact and must not be read as local official weather-warning levels.

No matching retrieved reports does not establish an absence of disasters. Coverage, pagination, event selection, source updates and point-based filtering can omit relevant information. This panel supplements rather than expands the NWS official-warning coverage described above.

## Satellite and base maps

[NASA GIBS](https://nasa-gibs.github.io/gibs-api-docs/access-basics/) publishes the layer metadata and timestamped imagery tiles used by the map:

- `GOES-East_ABI_Band13_Clean_Infrared`
- `GOES-West_ABI_Band13_Clean_Infrared`
- `Himawari_AHI_Band13_Clean_Infrared`
- `MODIS_Terra_CorrectedReflectance_TrueColor`

Infrared geostationary layers represent thermal observations, not visible-color photographs, rainfall radar, or a temperature sensor on the ground. Their viewing geometry has limits: cloud features distort near the limb, and a map zoom beyond native resolution adds no detail. Terra MODIS is a daily global true-color product with daylight, cloud and orbital limitations. It is not a live camera. See [imagery implementation notes](imagery.md) for frame selection and coverage.

Credits belong to NASA GIBS/EOSDIS and the original observing agencies, including NOAA for GOES and JMA for Himawari. A visible satellite layer does not authorize use of agency logos as endorsements.

The base map is [OpenStreetMap](https://www.openstreetmap.org/copyright), with attribution to OpenStreetMap contributors. Use of its public tile service must follow the [OSMF tile policy](https://operations.osmfoundation.org/policies/tiles/). Do not bulk-download tiles or add an offline tile pack. Map coverage and street labels do not establish passable roads or evacuation routes.

## Preparedness references

The original short checklist synthesizes general preparation advice from the [CDC's flood preparedness guide](https://www.cdc.gov/floods/safety/), [Maharashtra SDMA's NDMA do/don't guidance](https://sdma.maharashtra.gov.in/en/dos-and-donts/), and [NWS flood safety resources](https://www.weather.gov/safety/flood). It deliberately leaves location-specific evacuation routes, shelters and telephone numbers to the relevant authority. No source endorses this application.

The self-contained field kit at `/offline.html` also links to [NWS flood actions](https://www.weather.gov/safety/flood-during), [NWS lightning guidance](https://www.weather.gov/safety/lightning-tips), [CDC earthquake guidance](https://www.cdc.gov/earthquakes/safety/stay-safe-during-an-earthquake.html), [USFA wildfire evacuation guidance](https://www.usfa.fema.gov/wui/outreach/wildfire-evacuation.html), [NWS hurricane actions](https://www.weather.gov/safety/hurricane-action), [Ready NC communication tips](https://www.readync.gov/stay-informed/tips-communicating), and [NWS wireless-alert information](https://www.weather.gov/wrn/wea). These are short original summaries, not an integrated emergency service. Official source links require internet; the action cards do not.

## License boundary

The repository's MIT license covers original application code and documentation. It does not replace the licenses or terms of provider data, maps, imagery, trademarks or installed dependencies. Keep all required source attribution when adapting the application. Independently check redistribution rights before storing or republishing a provider's datasets.
