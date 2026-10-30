# Privacy and local data

StormSignal is a static weather application. This release has no StormSignal login, advertising, analytics SDK or app-operated account database. This does not mean browsing it is anonymous to its hosting or data providers.

## What leaves your browser

Your browser contacts the host to download the application. It also makes HTTPS requests directly to these services as you use their features:

| Recipient | Purpose | Request information |
| --- | --- | --- |
| Open-Meteo weather/air-quality APIs | Forecasts, comparison and air-quality models | Selected coordinates, requested variables, network information such as IP address |
| Open-Meteo geocoding | Search for places | The text you enter in search and network information |
| U.S. NWS | Official alerts in supported locations | Selected coordinates and network information |
| GDACS (`www.gdacs.org/gdacsapi/`) | Recent global cyclone, flood and wildfire reports | Date range, event types, impact levels, pagination and network information; the app does not send the selected coordinates or search radius to GDACS |
| NASA GIBS | Available frames and satellite tiles | Layer, dates, map tile coordinates and network information |
| OpenStreetMap tile service | Base map | Viewed tile coordinates and network information |
| Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`) | Interface typography | Font requests and network information such as IP address; no selected coordinates are included in the font request by the app |

Map requests can reveal the area you are viewing. A searched location need not be your current location. Do not enter home addresses or other sensitive information merely to obtain a city-level forecast.

The GDACS panel downloads a bounded global report snapshot and computes nearby results locally. Opening an official report link makes a separate request to GDACS for the chosen event.

The application does not automatically request device geolocation. The **Use my location** button requires a deliberate action and the browser's permission. Selected coordinates are then sent to data providers to obtain the requested information. You can refuse permission and use place search. The app does not continuously track device location.

Provider policies apply independently. [Open-Meteo's privacy terms](https://open-meteo.com/en/terms) describe technical logs that may contain geographic coordinates and retention of up to 90 days. Also review [NASA privacy](https://www.nasa.gov/privacy/), [NWS privacy](https://www.weather.gov/privacy), [OpenStreetMap privacy](https://osmfoundation.org/wiki/Privacy_Policy), and [Google's privacy policy](https://policies.google.com/privacy). A hosting provider may retain security and access logs under its own policy.

## What stays on this device

Browser storage holds saved places, the low-bandwidth preference, and checklist state. The preparedness checklist stores only its checked item identifiers, not contact names or emergency details. Local storage is not encrypted by this application and is readable by someone with access to your browser profile. Private browsing, browser cleanup or storage limits can remove it.

To remove local data, clear this site's cookies/site storage in your browser. Resetting the preparedness checklist removes its saved selections. Clearing local storage does not erase records already held by an external provider.

The application registers a service worker that caches same-origin app resources and the preparedness page after a successful online visit. It does not cache external weather, warnings or map tiles as offline data. Cached application files can remain until the browser removes them or you clear this site's storage. A cached interface does not provide new weather information while offline; external links also require a connection.

## Refreshes and optional notifications

While the dashboard is visible and the browser reports it is online, it checks supported official alerts every minute and refreshes weather-related panels every 15 minutes. GDACS reports refresh every 10 minutes. Short in-memory provider caches may satisfy a request without another network call. Returning to the visible dashboard also requests a refresh. The satellite panel refreshes availability separately. Provider/network failures can prevent any of these updates.

Page alerts are optional and require browser notification permission. The app creates local browser notifications from retrieved NWS alerts; it does not register a push-subscription server. Notifications require the page to remain open, with refreshes dependent on visibility and browser behavior. They are not a guaranteed background or emergency-warning channel. Disabling page alerts stops this session's notifications; browser settings control the site-level permission.

## Changes to this policy

Adding accounts, push subscriptions, telemetry, paid-provider credentials or a server would change this data flow. Document those changes and obtain appropriate permission before shipping them. No paid secret should be embedded in a public client bundle.
