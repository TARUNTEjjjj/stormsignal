import { useId, useMemo, useState, type PointerEvent } from 'react';
import { ChevronDown, CloudRain, MoveHorizontal, Thermometer, Wind } from 'lucide-react';
import { finite, localTime, value } from '../presentation';
import {
  CHART_HEIGHT,
  CHART_WIDTH,
  forecastDomain,
  forecastGeometry,
  forecastSeries,
  nearestForecastHour,
  pointPosition,
  valuePosition,
  type ForecastMetric,
} from '../forecast-chart';
import type { Hour, ModelForecast } from '../types';
import './ForecastExplorer.css';

const METRICS = {
  temperature: { label: 'Temperature', unit: '°C', icon: Thermometer },
  precipitation: { label: 'Rainfall', unit: 'mm', icon: CloudRain },
  wind: { label: 'Wind', unit: 'km/h', icon: Wind },
} as const;
const COLORS = ['#8be7d3', '#ffbb72', '#a6a3ff', '#82c9ec'];
const timeOptions: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
};

export default function ForecastExplorer({
  hours,
  models,
  timezone,
}: {
  hours: Hour[];
  models: ModelForecast[];
  timezone: string;
}) {
  const [metric, setMetric] = useState<ForecastMetric>('temperature');
  const [range, setRange] = useState(24);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const id = useId();
  const visibleRange = hours.length <= 24 ? 24 : range;
  const selected = useMemo(() => hours.slice(0, visibleRange), [hours, visibleRange]);
  const index = Math.min(selectedIndex, Math.max(0, selected.length - 1));
  const hour = selected[index];
  const { label, unit } = METRICS[metric];
  // Moving the inspection cursor changes readings, not the plotted series.
  const series = useMemo(
    () => forecastSeries(selected, models, metric),
    [selected, models, metric],
  );
  const domain = useMemo(() => forecastDomain(series, metric), [series, metric]);
  const geometries = useMemo(
    () => series.map((points) => forecastGeometry(points, domain)),
    [series, domain],
  );
  const x = hour ? pointPosition(hour.time, selected[0].time, selected.at(-1)!.time) : 0;
  const names = useMemo(() => ['Local forecast', ...models.map((model) => model.name)], [models]);
  const hasValues = series.some((points) => points.some((point) => finite(point.value)));
  const timeLabels = useMemo(
    () => selected.map((item) => localTime(item.time, timezone, timeOptions)),
    [selected, timezone],
  );
  const timeLabel = timeLabels[index] ?? 'No forecast hours available';
  const spokenReading = names
    .map(
      (name, seriesIndex) =>
        `${name}: ${finite(series[seriesIndex][index]?.value) ? `${value(series[seriesIndex][index].value, 1)} ${unit}` : 'unavailable'}`,
    )
    .join('. ');
  const axisIndices = [
    0,
    Math.floor((selected.length - 1) / 3),
    Math.floor((2 * (selected.length - 1)) / 3),
    selected.length - 1,
  ].filter((item, position, all) => item >= 0 && all.indexOf(item) === position);

  function inspect(event: PointerEvent<SVGSVGElement>) {
    if (event.type === 'pointermove' && event.pointerType !== 'mouse' && !event.buttons) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const raw = (event.clientX - bounds.left) / Math.max(1, bounds.width);
    // Match the SVG's 10-unit inset, so the cursor lands on the plotted hour.
    setSelectedIndex(
      nearestForecastHour(
        selected.map((item) => item.time),
        (raw * CHART_WIDTH - 10) / (CHART_WIDTH - 20),
      ),
    );
  }

  return (
    <div className="fe-explorer">
      <div className="fe-toolbar">
        <div className="fe-metrics" role="group" aria-label="Chart metric">
          {(Object.keys(METRICS) as ForecastMetric[]).map((key) => {
            const Icon = METRICS[key].icon;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={metric === key}
                onClick={() => setMetric(key)}
              >
                <Icon size={15} aria-hidden="true" />
                <span>{METRICS[key].label}</span>
              </button>
            );
          })}
        </div>
        <div className="fe-ranges" role="group" aria-label="Forecast duration">
          {[24, 72].map((duration) => (
            <button
              type="button"
              key={duration}
              aria-pressed={visibleRange === duration}
              disabled={duration === 72 && hours.length <= 24}
              title={
                duration === 72 && hours.length <= 24
                  ? 'Full workspace is needed for longer forecasts.'
                  : undefined
              }
              onClick={() => {
                setRange(duration);
                setSelectedIndex((current) => Math.min(current, duration - 1));
              }}
            >
              {duration}h
            </button>
          ))}
        </div>
      </div>

      <div className="fe-inspection">
        <div>
          <span className="fe-kicker">LOCAL FORECAST · {label.toUpperCase()}</span>
          <div className="fe-reading">
            {value(hour?.[metric], 1)}
            <span>{unit}</span>
          </div>
        </div>
        <div className="fe-reading-context">
          <strong>{timeLabel}</strong>
          <span>
            {finite(hour?.probability)
              ? `${value(hour.probability)}% rain chance`
              : 'Rain chance unavailable'}
          </span>
          <span className="fe-scrub-hint">
            <MoveHorizontal size={13} aria-hidden="true" /> Explore each hour
          </span>
        </div>
      </div>

      {selected.length > 0 ? (
        <>
          <div className="fe-plot-row">
            <div className="fe-scale" aria-hidden="true">
              {[domain.max, (domain.max + domain.min) / 2, domain.min].map((tick, position) => (
                <span key={position}>{value(tick, 1)}</span>
              ))}
            </div>
            <div className="fe-plot">
              <svg
                viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                preserveAspectRatio="none"
                role="img"
                aria-label={`${label} forecast, ${selected.length} available hours. Gaps mean unavailable data. Use the hour slider or exact data table below.`}
                onPointerDown={inspect}
                onPointerMove={inspect}
              >
                <defs>
                  <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={COLORS[0]} stopOpacity=".26" />
                    <stop offset="100%" stopColor={COLORS[0]} stopOpacity=".015" />
                  </linearGradient>
                </defs>
                {[10, CHART_HEIGHT / 2, CHART_HEIGHT - 10].map((y) => (
                  <line key={y} x1="10" x2="590" y1={y} y2={y} className="fe-gridline" />
                ))}
                {axisIndices.map((tick) => (
                  <line
                    key={tick}
                    x1={pointPosition(selected[tick].time, selected[0].time, selected.at(-1)!.time)}
                    x2={pointPosition(selected[tick].time, selected[0].time, selected.at(-1)!.time)}
                    y1="10"
                    y2="190"
                    className="fe-gridline fe-gridline-vertical"
                  />
                ))}
                <path d={geometries[0].area} fill={`url(#${id}-fill)`} />
                {geometries.map((geometry, seriesIndex) => (
                  <g key={names[seriesIndex]}>
                    <path
                      d={geometry.line}
                      fill="none"
                      stroke={COLORS[seriesIndex % COLORS.length]}
                      strokeWidth={seriesIndex === 0 ? 2.5 : 1.8}
                      strokeDasharray={seriesIndex ? '5 5' : undefined}
                      vectorEffect="non-scaling-stroke"
                    />
                    {geometry.isolated.map((point, pointIndex) => (
                      <circle
                        key={pointIndex}
                        cx={point.x}
                        cy={point.y}
                        r="3"
                        fill={COLORS[seriesIndex % COLORS.length]}
                      />
                    ))}
                  </g>
                ))}
                <line x1={x} x2={x} y1="7" y2="193" className="fe-cursor" />
                {series.map((points, seriesIndex) =>
                  finite(points[index]?.value) ? (
                    <g key={names[seriesIndex]}>
                      {seriesIndex === 0 && (
                        <circle
                          cx={x}
                          cy={valuePosition(points[index].value!, domain)}
                          r="8"
                          fill={COLORS[0]}
                          opacity=".13"
                        />
                      )}
                      <circle
                        cx={x}
                        cy={valuePosition(points[index].value!, domain)}
                        r="4"
                        fill={COLORS[seriesIndex % COLORS.length]}
                        stroke="#0a141b"
                        strokeWidth="2"
                      />
                    </g>
                  ) : null,
                )}
              </svg>
              {!hasValues && <p className="fe-chart-empty">No values available for this metric.</p>}
              <div className="fe-times" aria-hidden="true">
                {axisIndices.map((tick) => (
                  <span
                    key={tick}
                    style={{
                      left: `${(pointPosition(selected[tick].time, selected[0].time, selected.at(-1)!.time) / CHART_WIDTH) * 100}%`,
                      transform:
                        axisIndices.length === 1
                          ? 'translateX(-50%)'
                          : tick === axisIndices[0]
                            ? 'none'
                            : tick === axisIndices.at(-1)
                              ? 'translateX(-100%)'
                              : 'translateX(-50%)',
                    }}
                  >
                    {localTime(selected[tick].time, timezone, {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    <small>
                      {localTime(selected[tick].time, timezone, { day: '2-digit', month: 'short' })}
                    </small>
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="fe-slider-row">
            <label htmlFor={`${id}-hour`}>Inspect hour</label>
            <input
              id={`${id}-hour`}
              type="range"
              min={0}
              max={Math.max(0, selected.length - 1)}
              step={1}
              value={index}
              disabled={selected.length < 2}
              aria-valuetext={`${timeLabel}. ${spokenReading}`}
              aria-describedby={`${id}-instructions`}
              onChange={(event) => setSelectedIndex(Number(event.target.value))}
            />
            <span aria-hidden="true">
              {index + 1} / {selected.length}
            </span>
          </div>
          <p id={`${id}-instructions`} className="fe-accessible-note">
            Use arrow keys to inspect each hour. Home and End jump to the first and last hour.
            Missing readings are unavailable, not zero.
          </p>
        </>
      ) : (
        <p className="fe-empty">No forecast hours available. Refresh data to try again.</p>
      )}

      <div className="fe-legend" aria-label="Values at selected hour">
        {names.map((name, seriesIndex) => (
          <div key={name}>
            <i style={{ background: COLORS[seriesIndex % COLORS.length] }} aria-hidden="true" />
            <span>{name}</span>
            <strong>
              {finite(series[seriesIndex][index]?.value)
                ? `${value(series[seriesIndex][index].value, 1)} ${unit}`
                : 'Unavailable'}
            </strong>
          </div>
        ))}
      </div>
      <details className="fe-data">
        <summary>
          Explore exact hourly data <ChevronDown size={14} aria-hidden="true" />
        </summary>
        <div
          className="fe-table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Hourly forecast values"
        >
          <table>
            <caption>
              {label} ({unit}) · {timezone} · Missing values shown as unavailable
            </caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                {names.map((name) => (
                  <th key={name} scope="col">
                    {name}
                  </th>
                ))}
                <th scope="col">Rain chance</th>
                <th scope="col">Gust (km/h)</th>
              </tr>
            </thead>
            <tbody>
              {selected.map((item, rowIndex) => (
                <tr key={item.time}>
                  <th scope="row">{timeLabels[rowIndex]}</th>
                  {series.map((points, seriesIndex) => (
                    <td key={names[seriesIndex]}>
                      {finite(points[rowIndex]?.value)
                        ? value(points[rowIndex].value, 1)
                        : 'Unavailable'}
                    </td>
                  ))}
                  <td>
                    {finite(item.probability) ? `${value(item.probability)}%` : 'Unavailable'}
                  </td>
                  <td>{finite(item.gust) ? value(item.gust, 1) : 'Unavailable'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
