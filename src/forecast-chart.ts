import { finite } from './presentation';
import type { Hour, ModelForecast } from './types';

export type ForecastMetric = 'temperature' | 'precipitation' | 'wind';
export type ForecastPoint = { time: number; value: number | null };
export type ChartDomain = { min: number; max: number };
export const CHART_WIDTH = 600;
export const CHART_HEIGHT = 200;
const INSET = 10;

/** Durations describe elapsed time, even when the provider omits hourly records. */
export function forecastWindow(hours: Hour[], duration: number): Hour[] {
  const ordered = hours
    .filter((hour) => finite(hour.time))
    .slice()
    .sort((a, b) => a.time - b.time);
  const start = ordered[0]?.time;
  if (start === undefined || !finite(duration) || duration <= 0) return [];
  const seen = new Set<number>();
  return ordered.filter((hour) => {
    if (hour.time >= start + duration * 3_600_000 || seen.has(hour.time)) return false;
    seen.add(hour.time);
    return true;
  });
}

/** Export the same timestamp joins used by the chart; missing measurements stay empty. */
export function forecastCsv(
  hours: Hour[],
  models: ModelForecast[],
  metric: ForecastMetric,
): string {
  const units = { temperature: 'C', precipitation: 'mm', wind: 'km/h' };
  const cell = (value: string | number | null) => {
    if (typeof value === 'number') return finite(value) ? String(value) : '';
    if (value === null) return '';
    // Spreadsheet programs may execute formula-looking text even when it is CSV-quoted.
    const safe = /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const series = forecastSeries(hours, models, metric);
  const headings = [
    'time_utc',
    ...['Local forecast', ...models.map((model) => model.name)].map(
      (name) => `${name}: ${metric} (${units[metric]})`,
    ),
  ];
  return (
    [
      headings.map(cell).join(','),
      ...hours.map((hour, index) =>
        [new Date(hour.time).toISOString(), ...series.map((points) => points[index].value)]
          .map(cell)
          .join(','),
      ),
    ].join('\r\n') + '\r\n'
  );
}

/** Model values are joined by observation time, never by array position. */
export function forecastSeries(hours: Hour[], models: ModelForecast[], metric: ForecastMetric) {
  const local = hours.map((hour) => ({ time: hour.time, value: hour[metric] }));
  return [
    local,
    ...models.map((model) => {
      const byTime = new Map(model.hours.map((hour) => [hour.time, hour[metric]]));
      return hours.map((hour) => ({ time: hour.time, value: byTime.get(hour.time) ?? null }));
    }),
  ];
}

export function forecastDomain(series: ForecastPoint[][], metric: ForecastMetric): ChartDomain {
  const numbers = series.flatMap((points) => points.map((point) => point.value)).filter(finite);
  if (!numbers.length) return { min: 0, max: 1 };
  const min = metric === 'temperature' ? Math.floor(Math.min(...numbers)) : Math.min(0, ...numbers);
  const max = Math.ceil(Math.max(...numbers));
  const padding =
    metric === 'temperature' ? Math.max(1, (max - min) * 0.12) : Math.max(0.5, (max - min) * 0.1);
  return {
    min: metric === 'temperature' ? min - padding : min,
    max: Math.max(max + padding, min + 1),
  };
}

export function pointPosition(time: number, start: number, end: number) {
  return end > start
    ? INSET + ((time - start) / (end - start)) * (CHART_WIDTH - INSET * 2)
    : CHART_WIDTH / 2;
}

export function valuePosition(value: number, domain: ChartDomain) {
  return (
    CHART_HEIGHT -
    INSET -
    ((value - domain.min) / (domain.max - domain.min || 1)) * (CHART_HEIGHT - INSET * 2)
  );
}

/** A missing value or missing hourly timestamp breaks both line and area. */
export function forecastGeometry(points: ForecastPoint[], domain: ChartDomain) {
  const start = points[0]?.time ?? 0,
    end = points.at(-1)?.time ?? start;
  const segments: { x: number; y: number }[][] = [];
  let segment: { x: number; y: number }[] = [];
  let previousTime: number | undefined;
  for (const point of points) {
    if (!finite(point.value) || !finite(point.time)) {
      if (segment.length) segments.push(segment);
      segment = [];
      previousTime = undefined;
      continue;
    }
    if (
      previousTime !== undefined &&
      (point.time - previousTime > 90 * 60_000 || point.time <= previousTime)
    ) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    segment.push({
      x: pointPosition(point.time, start, end),
      y: valuePosition(point.value, domain),
    });
    previousTime = point.time;
  }
  if (segment.length) segments.push(segment);
  const coordinates = (points: { x: number; y: number }[]) =>
    points
      .map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
      .join(' ');
  return {
    line: segments.map(coordinates).join(' '),
    area: segments
      .filter((points) => points.length > 1)
      .map(
        (points) =>
          `${coordinates(points)} L${points.at(-1)!.x.toFixed(2)},${CHART_HEIGHT - INSET} L${points[0].x.toFixed(2)},${CHART_HEIGHT - INSET} Z`,
      )
      .join(' '),
    isolated: segments.filter((points) => points.length === 1).map((points) => points[0]),
  };
}

/** Find the actual timestamp nearest the pointer, including gaps in the timeline. */
export function nearestForecastHour(times: number[], fraction: number) {
  if (times.length < 2) return 0;
  const target =
    times[0] +
    Math.max(0, Math.min(1, finite(fraction) ? fraction : 0)) * (times.at(-1)! - times[0]);
  let nearest = 0;
  times.forEach((time, index) => {
    if (Math.abs(time - target) < Math.abs(times[nearest] - target)) nearest = index;
  });
  return nearest;
}
