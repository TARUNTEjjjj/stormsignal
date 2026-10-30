# Satellite map

StormSignal requests NASA EOSDIS GIBS imagery directly from the browser. No NASA account or API key is required by these public endpoints. This is satellite observation imagery, not rainfall radar, a forecast model or a street camera.

## Layers and coverage

| Layer | Native grid | Time and coverage |
| --- | --- | --- |
| GOES-East ABI band 13 clean infrared | `GoogleMapsCompatible_Level6` | Advertised 10-minute observations, Americas/adjacent Atlantic |
| GOES-West ABI band 13 clean infrared | `GoogleMapsCompatible_Level6` | Advertised 10-minute observations, Pacific/western Americas |
| Himawari AHI band 13 clean infrared | `GoogleMapsCompatible_Level6` | Advertised 10-minute observations, Asia–Pacific |
| Terra MODIS corrected reflectance true color | `GoogleMapsCompatible_Level9` | Daily daytime swath composite; global except Web Mercator pole limits |

Infrared source resolution is about 2 km at nadir and becomes coarser toward the disk edge. Leaflet overzoom enlarges pixels; it does not create more detail. The geostationary selector chooses the satellite with the smallest angular distance to the selected coordinates, limits latitude to ±65°, and conservatively excludes angular distance greater than 72° from the satellite subpoint. Those bounds are an application display choice, not an official instrument footprint. India is near Himawari's western disk edge. Europe, much of Africa and high latitudes fall back to the daily MODIS option. Selected coordinates above ±85° are explicitly flagged because the map cannot display their exact latitude.

Infrared colors encode brightness temperature; they are not precipitation rate or an assessment of danger at ground level. The interface links the provider's official color scale. Cloud cover, missing overpasses, disk-edge geometry and gaps in reception can leave blank regions. A blank region never establishes safe or clear weather.

## Honest timestamps

The client makes a small per-layer `DescribeDomains` request, bounded to the last 24 hours for geostationary imagery or seven days for daily imagery. Only the times actually advertised in returned intervals can appear on the slider. Future dates are excluded. Gaps remain gaps. The last 12 available infrared frames, or last five daily composites, are selectable. Animation advances at 1.8 seconds per displayed frame; it does not simulate intermediate observations.

Metadata is cached in memory for five minutes and refreshed every five minutes while the map is enabled. The user can refresh manually. Infrared observations more than 90 minutes old and daily composites more than three days old are labelled delayed. Those freshness thresholds describe this application's display behavior, not provider latency guarantees. Daily mosaics show their date instead of a fabricated single capture time; today's mosaic can be incomplete. Processing delay means the newest metadata is not necessarily the current instant.

The tile URL contains the exact selected timestamp. No `default`, `latest` or current-time guess is substituted for an observation. The provider may still return transparent/missing pixels for an advertised frame. HTTP tile failures and unavailable metadata are visible and do not turn into synthetic imagery.

## Base map, privacy and data saver

OpenStreetMap tiles supply geographic context and labels. Visible attribution links to OSM copyright and NASA GIBS are included on the map. Requests use the browser's ordinary caching, user agent and referrer behavior. The app does not bulk download, prefetch offline map tiles or override HTTP cache lifetimes. Only visible map tiles are requested. Browser requests reveal IP address and requested geographic tiles to these providers. The shared URL is not sent as an exact location claim; consult the project's privacy notice for all data flows.

Data saver mode prevents map tile and imagery-metadata requests until the visitor explicitly loads the map. Forecast and official-alert text can still be used. A future deployment with substantial traffic must arrange an appropriate base-map provider or self-hosting rather than assume unlimited OSM capacity.

Only active official-alert geometries supplied by the alert provider are drawn with red borders. The map does not invent evacuation areas, flood boundaries or red zones. Alerts without geometry remain in the textual alert list.

## Verified sources

- [GIBS API access and time dimensions](https://nasa-gibs.github.io/gibs-api-docs/access-basics/)
- [GIBS resolutions and product conventions](https://nasa-gibs.github.io/gibs-api-docs/access-advanced-topics/)
- [NASA Worldview and geostationary imagery](https://github.com/nasa-gibs/worldview)
- [Current GIBS Web Mercator capabilities](https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml)
- [Infrared brightness-temperature scale](https://gibs.earthdata.nasa.gov/legends/Clean_Longwave_Infrared_Window_Band_H.svg)
- [OpenStreetMap tile policy](https://operations.osmfoundation.org/policies/tiles/)

Live endpoint validation on 30 October 2026 retrieved GIBS capabilities with the listed layer identifiers, a short Himawari `DescribeDomains` XML response with 10-minute interval metadata, and a 256×256 PNG at a timestamp returned by that metadata. This proves those endpoints worked at verification time; it is not an availability guarantee.
