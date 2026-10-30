import type { Place, Hour, ModelForecast } from './types';
export const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
export function value(n: number | null | undefined, digits = 0) {
  return finite(n) ? n.toFixed(digits) : '—';
}
export function localTime(
  time: number,
  timezone = 'UTC',
  options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' },
) {
  if (!finite(time)) return 'Unavailable';
  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: timezone }).format(time);
  } catch {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(time);
  }
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
export function readPlaces(raw: string | null): Place[] {
  try {
    const data = JSON.parse(raw || '[]');
    return Array.isArray(data)
      ? data
          .filter(
            (p): p is Place =>
              !!p &&
              typeof p.id === 'string' &&
              typeof p.name === 'string' &&
              p.name.length < 150 &&
              typeof p.country === 'string' &&
              typeof p.countryCode === 'string' &&
              finite(p.latitude) &&
              Math.abs(p.latitude) <= 90 &&
              finite(p.longitude) &&
              Math.abs(p.longitude) <= 180,
          )
          .slice(0, 8)
      : [];
  } catch {
    return [];
  }
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
