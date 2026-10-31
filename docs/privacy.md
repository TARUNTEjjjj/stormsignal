# Privacy and local data

StormSignal serves its interface and a public-warning gateway through a Cloudflare Worker. This release has no StormSignal login, advertising, analytics SDK or app-operated account database. This does not mean browsing it is anonymous to its hosting or data providers.

## What leaves your browser

Your browser contacts the host to download the application. It also makes HTTPS requests directly to these services as you use their features:

| Recipient                           | Purpose                                           | Request information                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open-Meteo weather/air-quality APIs | Forecasts, comparison and air-quality models      | Selected coordinates, requested variables, network information such as IP address                                                                    |
| Open-Meteo geocoding                | Search for places                                 | The text you enter in search and network information                                                                                                 |
| U.S. NWS                            | Official alerts in supported locations            | Selected coordinates and network information                                                                                                         |
| GDACS (`www.gdacs.org/gdacsapi/`)   | Recent global cyclone, flood and wildfire reports | Date range, event types, impact levels, pagination and network information; the app does not send the selected coordinates or search radius to GDACS |
| NASA GIBS                           | Available frames and satellite tiles              | Layer, dates, map tile coordinates and network information                                                                                           |
| OpenStreetMap tile service          | Base map                                          | Viewed tile coordinates and network information                                                                                                      |

Map requests can reveal the area you are viewing. A searched location need not be your current location. Do not enter home addresses or other sensitive information merely to obtain a city-level forecast.

For India and other international warning checks, the browser sends selected coordinates, country, region and place name to StormSignal's `/api/alerts` endpoint. The gateway sends the selected point to WMO for geographic matching, or requests the appropriate Indian state/territory SACHET feed. Providers see the gateway's network request. There is no application analytics or location-history database; hosting access/security logs may contain request metadata. Public upstream warning responses and ETags are cached at the server/edge for revalidation, bounded to 24-hour retention; WMO source metadata is reused for six hours. User-specific API responses use `no-store`. No emergency-plan, contact or saved-briefing content is uploaded by this gateway.

For Philippine and Indonesian places, the gateway also reads fixed public PAGASA/BMKG feeds and their referenced CAP documents. For Kolkata, it reads IMD's fixed public district-nowcast RSS. These direct-source requests do not send your selected point to those authorities; matching happens on StormSignal's server. The supplementary WMO point query still includes coordinates. Source links open the authority's website separately when clicked. Direct warning text saved in a briefing remains historical and device-local.

The GDACS panel downloads a bounded global report snapshot and computes nearby results locally. Opening an official report link makes a separate request to GDACS for the chosen event.

The application does not automatically request device geolocation. The **Use my location** button requires a deliberate action and the browser's permission. Selected coordinates are then sent to data providers to obtain the requested information. You can refuse permission and use place search. The app does not continuously track device location.

Provider policies apply independently. Review [Open-Meteo's privacy terms](https://open-meteo.com/en/terms), [NASA privacy](https://www.nasa.gov/privacy/), [NWS privacy](https://www.weather.gov/privacy), and [OpenStreetMap privacy](https://osmfoundation.org/wiki/Privacy_Policy). A hosting provider may retain security and access logs under its own policy. The interface uses system fonts and does not request external font files.

**Data saver**, the default mode, requests a compact forecast and supported official warning data. Place search still contacts the geocoding service. It does not load maps, satellite imagery, comparison models, air-quality data or GDACS reports, and it does not poll in the background. **Full workspace** enables those additional features. **Offline only** pauses application data-provider requests and online place search; opening the website itself, browser-managed updates, and links you follow can still contact the host or destination. The downloaded emergency-kit HTML makes no background network requests.

## What stays on this device

Browser storage can hold:

- Saved places and their coordinates, the connection-mode preference, and preparedness-checklist selections.
- Up to three weather briefings when you explicitly choose **Save briefing**. A briefing includes the location, coordinates, original forecast retrieval and validity times, a bounded hourly forecast, and available warning text with its original issue/effective/expiry times. It excludes map geometry and imagery. The combined serialized briefing store is limited to 750,000 UTF-8 bytes.
- The emergency kit's contact name and phone, agreed meeting place, local authority information, personal notes, save time and checklist when you choose **Save plan on this device**. Checklist changes save checked identifiers automatically while preserving the last saved plan fields; unsaved plan edits still need Save or a download.

These records are device-local. StormSignal does not upload or synchronize them. Local storage is not encrypted by this application and is readable by someone with access to your browser profile. Private browsing, browser cleanup or storage limits can remove it. Corrupt or oversized briefing records are reported as unreadable and are not silently overwritten by a new save.

Downloaded briefing text contains the selected location and saved weather/warnings. A personalized downloaded HTML kit or JSON backup contains your plan fields and checklist. Downloads are created locally through the browser; no upload is involved. Anyone with access to the downloaded files can read them. Printing or using a browser/system share function can expose the selected content to that destination. A **Call saved contact** link opens a `tel:` action only when you choose it; completing a call depends on the device and telephone service.

To remove local data, clear this site's cookies/site storage in your browser. The briefing panel can remove an individual briefing, and has a confirmed clear action for unreadable briefing data. These actions do not remove your separate plan or downloaded files. Resetting the preparedness checklist removes its saved selections. Delete downloaded files separately. Clearing local storage does not erase records already held by an external provider.

The production application registers a service worker that caches the required same-origin application files, preparedness page and offline emergency kit after a successful online visit. Optional map/report code is cached only if used. It does not cache external weather, warnings or map tiles; explicit briefings are separate local records. Cached application files can remain until the browser removes them or you clear this site's storage. A cached interface does not provide new weather information while offline; external links also require a connection. The emergency-kit file opened from Downloads has its own browser-dependent storage behavior and may not share storage with the hosted site.

## Refreshes and optional notifications

In **Full workspace**, while the dashboard is visible and the browser reports it is online, it checks supported official alerts every minute and refreshes weather-related panels every 15 minutes. GDACS reports refresh every 10 minutes. Short in-memory provider caches may satisfy a request without another network call. Returning to the visible dashboard also requests a refresh. The satellite panel refreshes availability separately. Provider/network failures can prevent any of these updates. **Data saver** uses deliberate refreshes and new place selection rather than periodic polling. **Offline only** receives no new weather or warnings.

Page alerts are optional and require browser notification permission. The app creates local browser notifications from retrieved NWS alerts; it does not register a push-subscription server. Notifications require the page to remain open, with refreshes dependent on visibility and browser behavior. They are not a guaranteed background or emergency-warning channel. Disabling page alerts stops this session's notifications; browser settings control the site-level permission.

See [Offline and weak-signal use](offline.md) for preparation, storage limits and the differences between a saved weather briefing and the self-contained emergency kit.

## Changes to this policy

Adding accounts, push subscriptions, telemetry or paid-provider credentials would change this data flow. Document those changes and obtain appropriate permission before shipping them. No paid secret should be embedded in a public client bundle.
