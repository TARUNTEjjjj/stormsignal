# Offline and weak-signal use

StormSignal can keep preparation material and explicitly saved weather briefings available when a connection fails. It cannot receive new warnings, detect current hazards, confirm a route or locate an available shelter without an appropriate current source. Saved information never establishes that conditions are safe. Follow local authorities and keep independent warning channels available.

## Choose the connection mode

| Mode                     | Available behavior                                                                                                    | Requests and updates                                                                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Data saver** (default) | Compact 24-hour forecast, supported official warnings, saved briefings and emergency-kit links                        | Forecast and warning requests on load, place selection or deliberate refresh; place search uses the network. No map, satellite, comparison models, air-quality or GDACS downloads, and no periodic polling. |
| **Offline only**         | Previously saved briefings and the prepared emergency kit                                                             | Application data requests and online search pause. The dashboard does not present cached weather as current. Source links still need internet.                                                              |
| **Full workspace**       | Detailed forecast, imagery, comparison models, air quality, regional disaster reports and supported official warnings | Additional provider requests and automatic refreshes while visible and online.                                                                                                                              |

The chosen mode is remembered in this browser when storage is available. The browser's online signal does not prove that any provider is reachable. Selecting Offline only controls application data requests; the browser may still contact the site for its interface or service-worker updates. A completely disconnected, self-contained option is the downloaded emergency-kit HTML described below.

## Prepare while connected

1. Open StormSignal on the device and browser you expect to use. Start in Data saver, select the relevant place and wait for the forecast request to finish. Read the original retrieval time and warning coverage.
2. Choose **Save [place] briefing**. Check the success message. Saving a place in the navigation alone does not save its weather.
3. Use **Download text briefing** to keep a separate text copy. **Download current briefing** also creates a text copy directly from the fresh data even if browser storage is unavailable. The download preserves the location and original forecast/warning times.
4. Open **Emergency kit**, enter only the contact, meeting and authority details you need, and choose **Save plan on this device**. Agree the plan with the relevant people before an emergency.
5. In the kit, choose **Download offline HTML** to include the current plan fields and checklist in a self-contained file. Open the downloaded file from Files / Downloads, then test it with the network disconnected. Keep a printed copy or PDF too.
6. On the hosted dashboard, look for **Offline interface and kit saved on this device**. If caching is unconfirmed or incomplete, rely on a tested downloaded or printed copy. This status confirms interface files, not fresh weather or guaranteed future storage.

The dashboard's direct **Download offline-only kit** link downloads the generic kit. To include your personal plan, use the download button inside the kit after filling the fields. A text weather briefing and the kit HTML are separate files; the HTML does not embed your saved forecasts or warning feed.

## Read saved weather honestly

Every saved briefing is marked **SAVED COPY · CURRENT STATUS UNKNOWN**. It shows when it was saved, when the forecast was retrieved, the model time, and each hourly forecast's valid time. Warning copies retain their original issue, effective and stated-expiry times. A warning past its recorded expiry is labelled accordingly; an unexpired copy still is not verified as current. Warnings can change or be cancelled before their recorded expiry.

Warning retrieval uses NWS, direct PAGASA, BMKG and IMD Kolkata feeds, Indian regional SACHET feeds and participating WMO SWIC sources. Saved copies retain regional/point scope, incomplete-coverage notices and original bulletin times. A regional warning is not automatically a warning for the saved city. Unsupported locations retain an explicit message and official-source link. Missing, failed or stale warning retrieval is recorded as unavailable. **No warning text saved does not mean no danger.** Reading, exporting or selecting a saved briefing never refreshes its original source time.

When signal returns, select Data saver or Full workspace, refresh, and read the newly retrieved data before saving an updated briefing. Saving over a location is deliberate. Stored briefings are not automatically replaced by network responses.

## Storage bounds and failure handling

The briefing record at `stormsignal:offline-packs:v1` is a validated, versioned JSON object with these limits:

- At most **3 locations**, identified by coordinates rounded to four decimals. Saving the same location replaces it; saving a fourth replaces the oldest retained save.
- At most **24 hourly points** per location, chosen from the window starting one hour before save and ending 24 hours after save. Each point stores its valid time, temperature, feels-like temperature, rainfall, rain probability and gust. The model's current estimate and original retrieval time are retained separately.
- At most **5 warnings** per location, with an explicit count of additional omitted warnings. Full saved description and instruction fields are each bounded to 20,000 characters. Oversized or malformed text is rejected rather than silently shortened. Map geometries, map tiles and satellite images are excluded.
- At most **750,000 UTF-8 bytes** for the entire serialized store. This is an upper bound, not a promised download size or reserved browser quota. Text containing multibyte characters counts toward the byte limit.
- A new briefing requires a forecast retrieved within the previous hour. A warning retrieval more than five minutes old is recorded as unavailable. These are save-validation limits, not a claim that changing conditions remain safe for that duration.

Coordinates, finite weather quantities, timezone names, array bounds and timestamps are checked when saving and loading. Saved source links are restricted to HTTPS links on the allowed official weather domains. Unknown versions, invalid structures, duplicate locations and oversized storage are reported as unreadable. The app does not silently overwrite unreadable data. Clearing it requires an explicit confirmation; other StormSignal records remain untouched.

If a write exceeds the size bound or browser quota, the prior saved list is retained and the interface reports the failure. A fresh text download is still available. Old valid briefings are retained until replaced or removed; they are always historical, with an additional notice after one day. Browser cleanup or eviction can remove them independently.

## Self-contained emergency kit

`offline.html` contains its own styles, scripts, preparation checklist and short hazard action cards. It has no remote images, fonts, code dependencies or background data requests. The action cards remain readable with JavaScript disabled. Editing, local saves, JSON backup and personalized downloads need JavaScript. It contains no current forecast, live warning feed, shelter directory or route recommendations.

The device-local plan uses `stormsignal:field-kit:v1`. It has bounded fields for contact name, contact phone, agreed meeting place, local authority information and notes. **Save plan on this device** saves those fields and the checklist. Checklist changes save independently while preserving the last saved plan; editing a field alone does not persist it. A download includes the fields currently visible in the form, even if they have not been saved to browser storage.

**Export plan backup** produces a small JSON file. **Restore a plan backup** validates a selected file, with a 12,000-byte file limit, then replaces the form and checklist in the page. Choose Save afterward to persist restored fields. Nothing is uploaded. The call link requires your action, a supported device and telephone service; this kit does not send messages or dispatch help.

## Browser and privacy limits

Hosted offline caching depends on a successful earlier visit, completed service-worker installation and retained browser storage. A first-ever visit without a connection cannot download the app. Private browsing, restricted storage, device pressure or site-data cleanup can remove cached files or plans. The offline status is a check at that time, not a guarantee of future availability.

Opening a local `file://` HTML document differs between browsers and mobile file viewers. It may not share local storage with the hosted website, and local saves may be blocked or handled differently for each file. The personalized HTML includes the plan so it can still be read without that storage. Test the actual downloaded file on the intended device; use Print / save PDF or paper if the file viewer does not support it. Download an updated copy after changing your plan.

Briefings, plan records and downloaded files are not encrypted by StormSignal. They can reveal selected coordinates, contacts and meeting details to anyone who can access the browser profile or file. Keep copies private, delete obsolete downloads separately, and use browser site-data controls to remove local records and cached files. See [Privacy and local data](privacy.md).
