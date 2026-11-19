# Satellite map

StormSignal requests NASA EOSDIS GIBS imagery directly from the browser. No NASA account or API key is required by these public endpoints. This is satellite observation imagery, not rainfall radar, a forecast model or a street camera.

## Layers and coverage

| Layer                                        | Native grid                   | Time and coverage                                                     |
| -------------------------------------------- | ----------------------------- | --------------------------------------------------------------------- |
| GOES-East ABI band 13 clean infrared         | `GoogleMapsCompatible_Level6` | Advertised 10-minute observations, Americas/adjacent Atlantic         |
| GOES-West ABI band 13 clean infrared         | `GoogleMapsCompatible_Level6` | Advertised 10-minute observations, Pacific/western Americas           |
| Himawari AHI band 13 clean infrared          | `GoogleMapsCompatible_Level6` | Advertised 10-minute observations, Asia–Pacific                       |
| Terra MODIS corrected reflectance true color | `GoogleMapsCompatible_Level9` | Daily daytime swath composite; global except Web Mercator pole limits |

Infrared source resolution is about 2 km at nadir and becomes coarser toward the disk edge. Leaflet overzoom enlarges pixels; it does not create more detail. The geostationary selector chooses the satellite with the smallest angular distance to the selected coordinates, limits latitude to ±65°, and conservatively excludes angular distance greater than 72° from the satellite subpoint. Those bounds are an application display choice, not an official instrument footprint. India is near Himawari's western disk edge. Europe, much of Africa and high latitudes fall back to the daily MODIS option. Selected coordinates above ±85° are explicitly flagged because the map cannot display their exact latitude.

Infrared colors encode brightness temperature; they are not precipitation rate or an assessment of danger at ground level. The interface links the provider's official color scale. Cloud cover, missing overpasses, disk-edge geometry and gaps in reception can leave blank regions. A blank region never establishes safe or clear weather.

## Honest timestamps

The client makes a small per-layer `DescribeDomains` request, bounded to the last 24 hours for geostationary imagery or seven days for daily imagery. Only the times actually advertised in returned intervals can appear on the slider. Future dates are excluded. Gaps remain gaps. The last 12 available infrared frames, or last five daily composites, are selectable. Animation advances at 1.8 seconds per displayed frame; it does not simulate intermediate observations.

Metadata is cached in memory for five minutes and refreshed every five minutes while the map is enabled. The user can refresh manually. Infrared observations more than 90 minutes old and daily composites more than three days old are labelled delayed. Those freshness thresholds describe this application's display behavior, not provider latency guarantees. Daily mosaics show their date instead of a fabricated single capture time; today's mosaic can be incomplete. Processing delay means the newest metadata is not necessarily the current instant.

The tile URL contains the exact selected timestamp. No `default`, `latest` or current-time guess is substituted for an observation. The provider may still return transparent/missing pixels for an advertised frame. HTTP tile failures and unavailable metadata are visible and do not turn into synthetic imagery.

## 3D globe

In Full workspace the globe drapes whole-Earth GIBS images over a sphere. Each is one WMS 1.3.0 `GetMap` request in EPSG:4326 (`BBOX=-90,-180,90,180`, 2048×1024 JPEG): `BlueMarble_ShadedRelief_Bathymetry`, a static composite with no date and no clouds, and `VIIRS_NOAA20_CorrectedReflectance_TrueColor`, the daily mosaic, drawn on top. The daily dates come from that layer's `DescribeDomains` listing, read by the same code as the map's layers. The globe first takes the newest advertised day that has ended in UTC, or the newest advertised day when no earlier one is listed. It never substitutes `default` or a guessed date. Black pixels, which GIBS uses for gaps, count as not imaged. When that mosaic images less than 80% of Earth's surface (weighted by area), as a late or interrupted day does, or does not load, the globe also loads the advertised day before. It shows whichever covers more, and the notes name the newer day it passed over. The globe states the shown mosaic's date and coverage. Where it has no pixels, the static base shows through muted and hatched ("Not imaged that day" in the key), and the selected place's card says whether that place was imaged. The globe is about 20 km per pixel at the equator and cannot show local detail.

Day and night come from the subsolar point at the current UTC time, recomputed every minute, so the terminator makes no request. Once a warning check has measured the warning service's clock, the globe keeps that time, as warning expiry does: a device clock that is wrong moves neither the terminator nor the choice of mosaic. The night side is drawn at about a fifth of daylight brightness on screen (`SHADING` in `src/globe.ts`), dark enough to read as night with cloud and coastlines still faintly visible; the violet twilight line, the atmosphere glow and the night tint are illustration. Selected and saved places are drawn locally, and only active official warnings that carry an outline are drawn, in the map's red on a dark casing; outlines beyond the horizon are not drawn, and the gateway's cut along 180° is not drawn as a boundary. Satellite mosaics are not radar or a live camera, and nothing on the globe indicates that a place is safe.

GIBS sends these images with `Cache-Control: no-store`, so the browser cannot cache them; the page keeps the decoded images in memory while the globe is open and for a minute after it closes, so a quick switch of connection mode downloads nothing again, and requests nothing while offline. A partial mosaic is kept until the next look, which reads it again, since it may have filled in. While the page is shown and online, the globe looks for a newer mosaic after UTC midnight, and hourly while the shown mosaic is partial, older than the newest listed, or the last look failed. A look that fails leaves the shown mosaic on the globe with its date, and the notes say that the check failed; the globe never keeps drawing clouds its labels call missing. A failed image leaves a plain sphere with a graticule and a notice, never a guessed surface, and Try again asks again only for the layer that failed. The globe checks for WebGL 2 before it downloads three.js. Without it the card becomes a short notice with the selected place's daylight; after the graphics context is lost or a frame fails to draw, the globe shows a fallback with Restart. Either way it says it cannot draw warning outlines and points to the warning list; search, quick locations and the map still select places.

## Base map, privacy and data saver

OpenStreetMap tiles supply geographic context and labels. Visible attribution links to OSM copyright and NASA GIBS are included on the map. Requests use the browser's ordinary caching, user agent and referrer behavior. The app does not bulk download, prefetch offline map tiles or override HTTP cache lifetimes. Only visible map tiles are requested. Browser requests reveal IP address and requested geographic tiles to these providers. The shared URL is not sent as an exact location claim; consult the project's privacy notice for all data flows.

Data saver mode prevents map tile and imagery-metadata requests until the visitor explicitly loads the map, and never loads the globe. Forecast and official-alert text can still be used. A future deployment with substantial traffic must arrange an appropriate base-map provider or self-hosting rather than assume unlimited OSM capacity.

Only active official-alert geometries supplied by the alert provider are drawn with red borders. The map does not invent evacuation areas, flood boundaries or red zones. Alerts without geometry remain in the textual alert list.

## Verified sources

- [GIBS API access and time dimensions](https://nasa-gibs.github.io/gibs-api-docs/access-basics/)
- [GIBS resolutions and product conventions](https://nasa-gibs.github.io/gibs-api-docs/access-advanced-topics/)
- [NASA Worldview and geostationary imagery](https://github.com/nasa-gibs/worldview)
- [Current GIBS Web Mercator capabilities](https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml)
- [Infrared brightness-temperature scale](https://gibs.earthdata.nasa.gov/legends/Clean_Longwave_Infrared_Window_Band_H.svg)
- [OpenStreetMap tile policy](https://operations.osmfoundation.org/policies/tiles/)

Live endpoint validation on 30 October 2026 retrieved GIBS capabilities with the listed layer identifiers, a short Himawari `DescribeDomains` XML response with 10-minute interval metadata, and a 256×256 PNG at a timestamp returned by that metadata. This proves those endpoints worked at verification time; it is not an availability guarantee. Live validation on 18 November 2026 (three requests) retrieved a VIIRS NOAA-20 `DescribeDomains` response advertising 2026-11-11 to 2026-11-18, and 2048×1024 JPEG `GetMap` responses for `BlueMarble_ShadedRelief_Bathymetry` (284 KB) and the 17 November VIIRS mosaic (297 KB), each with `Access-Control-Allow-Origin: *`; that mosaic covered about 46% of Earth. A page load on 18 November 2026 at 20:55 UTC found the 17 November mosaic still at 45%, so the globe also loaded the 16 November mosaic (549 KB, 93%) and showed that one.
