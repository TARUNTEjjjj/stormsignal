import type { Forecast, Hazard, Hour } from './types';

const HOUR = 3_600_000;
export const FORECAST_STALE_MS = 60 * 60_000;

/** Product screening thresholds, not official warning criteria or a validated risk model.
 * Rain: 5/15 mm in one hour; gusts: 50/75 km/h; apparent heat: 35/40 °C;
 * cold: -5/-15 °C actual temperature; UV: 6/8; thunder: WMO 95/96/99.
 * Local vulnerability, terrain, drainage, and recent rainfall are not represented.
 */
export function deriveHazards(forecast: Forecast, now = Date.now()): Hazard[] {
  if (
    !Number.isFinite(forecast.fetchedAt) ||
    now - forecast.fetchedAt > FORECAST_STALE_MS ||
    forecast.fetchedAt > now + 5 * 60_000
  )
    return [];
  const hours = forecast.hours.filter(
    (h) => Number.isFinite(h.time) && h.time >= now && h.time < now + 24 * HOUR,
  );
  const results = new Map<Hazard['kind'], Hazard>();
  const add = (hazard: Hazard) => {
    const previous = results.get(hazard.kind);
    if (!previous || (hazard.level === 'high' && previous.level !== 'high'))
      results.set(hazard.kind, hazard);
  };
  for (const h of hours) {
    if (isNumber(h.precipitation) && h.precipitation >= 5)
      add({
        kind: 'rain',
        level: h.precipitation >= 15 ? 'high' : 'elevated',
        title: 'Heavy rain signal',
        detail: `${h.precipitation.toFixed(1)} mm forecast in one hour. Local flooding can occur below this screening threshold.`,
        time: h.time,
      });
    if (isNumber(h.gust) && h.gust >= 50)
      add({
        kind: 'wind',
        level: h.gust >= 75 ? 'high' : 'elevated',
        title: 'Strong gust signal',
        detail: `Gusts around ${Math.round(h.gust)} km/h in the forecast. Follow local wind warnings.`,
        time: h.time,
      });
    if (isNumber(h.apparent) && h.apparent >= 35)
      add({
        kind: 'heat',
        level: h.apparent >= 40 ? 'high' : 'elevated',
        title: 'Heat exposure signal',
        detail: `Feels-like temperature around ${Math.round(h.apparent)}°C. Individual heat risk varies.`,
        time: h.time,
      });
    if (isNumber(h.temperature) && h.temperature <= -5)
      add({
        kind: 'cold',
        level: h.temperature <= -15 ? 'high' : 'elevated',
        title: 'Cold exposure signal',
        detail: `Air temperature around ${Math.round(h.temperature)}°C. Wind and exposure can increase risk.`,
        time: h.time,
      });
    if (isNumber(h.uv) && h.uv >= 6)
      add({
        kind: 'uv',
        level: h.uv >= 8 ? 'high' : 'elevated',
        title: 'High UV signal',
        detail: `Forecast UV index ${h.uv.toFixed(1)}. Plan shade and sun protection.`,
        time: h.time,
      });
    if (h.code !== null && [95, 96, 99].includes(h.code))
      add({
        kind: 'thunder',
        level: h.code === 95 ? 'elevated' : 'high',
        title: 'Thunderstorm signal',
        detail:
          'The forecast includes thunderstorms. Timing and exact storm location are uncertain; follow official updates.',
        time: h.time,
      });
  }
  return [...results.values()].sort((a, b) =>
    a.level === b.level ? a.time - b.time : a.level === 'high' ? -1 : 1,
  );
}

function isNumber(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
export interface Outlook {
  level: 'unknown' | 'watch' | 'elevated' | 'high';
  title: string;
  detail: string;
}

/** A short summary of model signals, never a safety clearance. Caller must gate stale forecasts. */
export function getOutlook(hours: Hour[], now = Date.now()): Outlook {
  const next = hours.filter((h) => h.time >= now && h.time < now + 24 * HOUR);
  if (
    !next.length ||
    !next.some((h) =>
      [h.temperature, h.apparent, h.precipitation, h.gust, h.uv, h.code].some(isNumber),
    )
  )
    return {
      level: 'unknown',
      title: 'Forecast coverage unavailable',
      detail:
        'There is not enough current model data to assess the next 24 hours. Check your official weather authority.',
    };
  const hazards = deriveHazards(
    { fetchedAt: now, hours: next, timezone: 'UTC', current: next[0], days: [], source: '' },
    now,
  );
  if (hazards.some((h) => h.level === 'high'))
    return {
      level: 'high',
      title: 'Strong forecast signals',
      detail: `${hazards.length} weather signal${hazards.length === 1 ? '' : 's'} in the next 24 hours. These are model estimates, not official warnings.`,
    };
  if (hazards.length)
    return {
      level: 'elevated',
      title: 'Weather worth watching',
      detail: `${hazards.length} weather signal${hazards.length === 1 ? '' : 's'} in the next 24 hours. Check official advice before plans.`,
    };
  return {
    level: 'watch',
    title: 'Keep an eye on local updates',
    detail:
      'No selected screening threshold is crossed in the available model data. This does not rule out hazardous conditions.',
  };
}
