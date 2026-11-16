import type { Place, Hour, ModelForecast } from './types.ts';
export const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
export function value(n: number | null | undefined, digits = 0) {
  if (!finite(n)) return '—';
  const text = n.toFixed(digits);
  // toFixed keeps the sign of a negative value that rounds to zero: -0.3 °C would read "-0".
  return Number(text) === 0 ? text.replace('-', '') : text;
}
const MAX_TIME_FORMATTERS = 64;
const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function timeFormatter(timezone: string, options: Intl.DateTimeFormatOptions) {
  // Match the previous spread/override semantics. Property order and explicitly
  // undefined options must not create a formatter for every equivalent call.
  const formatOptions = { ...options, timeZone: timezone };
  const key = JSON.stringify(
    Object.entries(formatOptions)
      .filter(([, option]) => option !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const existing = timeFormatters.get(key);
  if (existing) {
    timeFormatters.delete(key);
    timeFormatters.set(key, existing);
    return existing;
  }
  const formatter = new Intl.DateTimeFormat('en-GB', formatOptions);
  if (timeFormatters.size >= MAX_TIME_FORMATTERS)
    timeFormatters.delete(timeFormatters.keys().next().value!);
  timeFormatters.set(key, formatter);
  return formatter;
}
export function localTime(
  time: number,
  timezone = 'UTC',
  options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' },
) {
  if (!finite(time)) return 'Unavailable';
  try {
    return timeFormatter(timezone, options).format(time);
  } catch {
    return timeFormatter('UTC', options).format(time);
  }
}
const WARNING_TIME: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
};
/**
 * Official warning times always name their zone. They are read beside the viewer's own clock while
 * another place is selected, and a repeated daylight-saving hour must stay distinct.
 */
export function warningTime(time: number, timezone = 'UTC', withYear = false) {
  return localTime(time, timezone, withYear ? { ...WARNING_TIME, year: 'numeric' } : WARNING_TIME);
}
const CALENDAR_DATE: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
};
/**
 * The name of a 7-day outlook row: "Today" or a short weekday. Open-Meteo starts every daily step
 * at local midnight by the one UTC offset in force when the forecast was requested, so after a
 * clock change a step starts an hour before or after midnight. The middle of the step always
 * falls on the provider's date.
 */
export function outlookDayLabel(dayTime: number, timezone: string, now: number) {
  const midday = dayTime + 12 * 3_600_000;
  return localTime(midday, timezone, CALENDAR_DATE) === localTime(now, timezone, CALENDAR_DATE)
    ? 'Today'
    : localTime(midday, timezone, { weekday: 'short' });
}
const RADIAN = Math.PI / 180;
/**
 * Whether the sun is up at a point (its upper edge above the horizon, allowing for refraction),
 * from the U.S. Naval Observatory's approximate solar coordinates. The forecast carries no
 * day/night flag; this only chooses between the sun and moon icons for a clear sky.
 */
export function isDaylight(time: number, latitude: number, longitude: number): boolean {
  const days = time / 86_400_000 - 10_957.5; // since 2000-01-01 12:00 UTC (J2000.0)
  const anomaly = (357.529 + 0.98560028 * days) * RADIAN;
  const ecliptic =
    (280.459 + 0.98564736 * days + 1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly)) *
    RADIAN;
  const obliquity = (23.439 - 0.00000036 * days) * RADIAN;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(ecliptic));
  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(ecliptic), Math.cos(ecliptic));
  // Greenwich mean sidereal time plus east longitude, less right ascension.
  const hourAngle = (280.46061837 + 360.98564736629 * days + longitude) * RADIAN - rightAscension;
  const lat = latitude * RADIAN;
  return (
    Math.sin(lat) * Math.sin(declination) +
      Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle) >
    Math.sin(-0.833 * RADIAN)
  );
}
/** Displayed area text keeps to the bound that saved briefings also apply. */
export const AREA_TEXT_LIMIT = 4000;
/**
 * Join the area names of a warning for display. A list longer than the bound keeps whole leading
 * names and states how many more the official bulletin names, so a later area is never cut off
 * silently. The warning gateway (CAP areas) and the browser (NWS area lists) both use it.
 */
export function areaNamesText(names: string[], limit = AREA_TEXT_LIMIT): string {
  const all = names.join('; ');
  if (all.length <= limit) return all;
  const more = (count: number) => ` … [${count} more area(s) named in the official bulletin]`;
  let shown = 0,
    length = -2;
  while (
    shown < names.length &&
    length + 2 + names[shown].length + more(names.length - shown - 1).length <= limit
  )
    length += 2 + names[shown++].length;
  if (shown) return names.slice(0, shown).join('; ') + more(names.length - shown);
  // The first name alone is longer than the bound: shorten it at a word and say so.
  const rest = names.length - 1;
  const note = ` … [area text shortened${rest ? `; ${rest} more area(s)` : ''}; see the official bulletin]`;
  const head = names[0].slice(0, limit - note.length);
  return (head.lastIndexOf(' ') > 0 ? head.slice(0, head.lastIndexOf(' ')) : head) + note;
}
/**
 * How far a device clock is from the warning service's, as "about 12 minutes ahead of" or "about
 * 3 hours behind" (`clockOffset` is the device clock minus the service's, in milliseconds). Empty
 * when they differ by less than five minutes, which needs no remark.
 */
export function clockDifference(clockOffset: number | undefined): string {
  if (!finite(clockOffset) || Math.abs(clockOffset) < 5 * 60_000) return '';
  const minutes = Math.round(Math.abs(clockOffset) / 60_000);
  const amount =
    minutes < 120
      ? `${minutes} minutes`
      : minutes < 48 * 60
        ? `${Math.round(minutes / 60)} hours`
        : `${Math.round(minutes / 1440)} days`;
  return `about ${amount} ${clockOffset > 0 ? 'ahead of' : 'behind'}`;
}
/**
 * What to tell the viewer of a live warning check made with such a clock; otherwise nothing.
 * Warnings are still listed by the service's clock, but official times will not match what the
 * device shows as the current time.
 */
export function clockNotice(clockOffset: number | undefined): string {
  const difference = clockDifference(clockOffset);
  return difference
    ? `This device’s clock is ${difference} the warning service’s clock. Warnings are listed by the service’s clock, so none is dropped early or kept late. Compare official times with a correct clock, and check this device’s date and time.`
    : '';
}
export function age(time: number, now = Date.now()) {
  if (!finite(time)) return 'Unknown age';
  const m = Math.max(0, Math.floor((now - time) / 60000));
  return m < 1
    ? 'just now'
    : m < 60
      ? `${m}m ago`
      : m < 1440
        ? `${Math.floor(m / 60)}h ${m % 60}m ago`
        : `${Math.floor(m / 1440)}d ago`;
}
/** Saved places are a short list, the most recently saved first. */
export const MAX_SAVED_PLACES = 8;
export function readPlaces(raw: string | null): Place[] {
  // Storage is untrusted and may outlive an older application version.
  if (raw && raw.length > 65_536) return [];
  try {
    const data = JSON.parse(raw || '[]');
    if (!Array.isArray(data)) return [];
    const places: Place[] = [];
    const text = (value: unknown, max: number, empty = false): value is string =>
      typeof value === 'string' && value.length <= max && (empty || !!value.trim());
    for (const p of data) {
      if (
        !p ||
        typeof p !== 'object' ||
        Array.isArray(p) ||
        !text(p.id, 300) ||
        !text(p.name, 150) ||
        !text(p.country, 200, true) ||
        !text(p.countryCode, 2, true) ||
        (p.countryCode && !/^[a-z]{2}$/i.test(p.countryCode)) ||
        !finite(p.latitude) ||
        Math.abs(p.latitude) > 90 ||
        !finite(p.longitude) ||
        Math.abs(p.longitude) > 180 ||
        (p.admin != null && !text(p.admin, 200, true)) ||
        (p.timezone != null && !text(p.timezone, 100))
      )
        continue;
      if (p.timezone != null) {
        try {
          timeFormatter(p.timezone, {});
        } catch {
          continue;
        }
      }
      places.push({
        id: p.id,
        name: p.name,
        country: p.country,
        countryCode: p.countryCode.toUpperCase(),
        latitude: p.latitude,
        longitude: p.longitude,
        ...(p.admin == null ? {} : { admin: p.admin }),
        ...(p.timezone == null ? {} : { timezone: p.timezone }),
      });
      if (places.length === MAX_SAVED_PLACES) break;
    }
    return places;
  } catch {
    return [];
  }
}
/**
 * The saved-place list after saving or removing `place`, built from what storage holds now: another
 * window may have saved, removed or cleared places since this one read the list. A full list keeps
 * the most recent places and reports the one it had to remove.
 */
export function toggleSavedPlace(
  raw: string | null,
  place: Place,
  remove: boolean,
): { places: Place[]; dropped: Place | null } {
  const others = readPlaces(raw).filter(
    (saved) =>
      Math.abs(saved.latitude - place.latitude) >= 0.01 ||
      Math.abs(saved.longitude - place.longitude) >= 0.01,
  );
  const places = remove ? others : [place, ...others];
  return {
    places: places.slice(0, MAX_SAVED_PLACES),
    dropped: places[MAX_SAVED_PLACES] ?? null,
  };
}
export function chartPaths(
  values: (number | null)[],
  min: number,
  max: number,
  width = 600,
  height = 140,
) {
  const spread = max - min || 1;
  return values
    .map((v, i) =>
      finite(v)
        ? `${i === 0 || !finite(values[i - 1]) ? 'M' : 'L'}${((i / Math.max(1, values.length - 1)) * width).toFixed(1)},${(height - ((v - min) / spread) * height).toFixed(1)}`
        : '',
    )
    .join(' ');
}
export function modelSpread(models: ModelForecast[], hours: Hour[]): number | null {
  if (models.length < 2) return null;
  const times = new Set(hours.map((h) => h.time));
  let max: number | null = null;
  for (const h of models[0].hours) {
    if (!times.has(h.time) || !finite(h.temperature)) continue;
    const b = models[1].hours.find((x) => x.time === h.time);
    if (b && finite(b.temperature))
      max = Math.max(max ?? 0, Math.abs(h.temperature - b.temperature));
  }
  return max;
}
