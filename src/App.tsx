import { lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Bookmark,
  Check,
  ChevronDown,
  Cloud,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CircleHelp,
  Compass,
  Database,
  Droplets,
  ExternalLink,
  Eye,
  Code2,
  Globe2,
  Layers,
  LocateFixed,
  MapPin,
  Menu,
  Moon,
  Radio,
  RefreshCw,
  Satellite,
  Search,
  ShieldCheck,
  Sun,
  Thermometer,
  TriangleAlert,
  Waves,
  WifiOff,
  Wind,
  X,
} from 'lucide-react';
const WeatherMap = lazy(() => import('./components/WeatherMap'));
const DisasterWatch = lazy(() => import('./components/DisasterWatch'));
import OfflineBriefing from './components/OfflineBriefing';
import OptionalPanel from './components/OptionalPanel';
import {
  CONNECTION_KEY,
  readConnectionMode,
  networkPolicy,
  alertCheckIsRecent,
  type ConnectionMode,
} from './connectivity';
import {
  searchPlaces,
  fetchForecast,
  fetchCompactForecast,
  fetchModels,
  fetchAirQuality,
  fetchAlerts,
  weatherLabel,
  clearRequestCache,
} from './data';
import { deriveHazards, getOutlook, FORECAST_STALE_MS } from './risk';
import { localWarningSources, warningSourceFallback } from './warning-sources';
import { value, finite, localTime, age, readPlaces, chartPaths, modelSpread } from './presentation';
import type { Place, Forecast, ModelForecast, AirQuality, AlertResult, Hour } from './types';

const PRESETS: Place[] = [
  {
    id: 'chennai',
    name: 'Chennai',
    country: 'India',
    countryCode: 'IN',
    latitude: 13.0827,
    longitude: 80.2707,
    timezone: 'Asia/Kolkata',
    admin: 'Tamil Nadu',
  },
  {
    id: '5391959',
    name: 'San Francisco',
    country: 'United States',
    countryCode: 'US',
    latitude: 37.77493,
    longitude: -122.41942,
    timezone: 'America/Los_Angeles',
    admin: 'California',
  },
  {
    id: '1275339',
    name: 'Mumbai',
    country: 'India',
    countryCode: 'IN',
    latitude: 19.07283,
    longitude: 72.88261,
    timezone: 'Asia/Kolkata',
    admin: 'Maharashtra',
  },
  {
    id: 'bhubaneswar-odisha',
    name: 'Bhubaneswar (Odisha)',
    country: 'India',
    countryCode: 'IN',
    latitude: 20.2724,
    longitude: 85.8339,
    timezone: 'Asia/Kolkata',
    admin: 'Odisha',
  },
  {
    id: '5128581',
    name: 'New York City',
    country: 'United States',
    countryCode: 'US',
    latitude: 40.71427,
    longitude: -74.00597,
    timezone: 'America/New_York',
    admin: 'New York',
  },
  {
    id: 'miami',
    name: 'Miami',
    country: 'United States',
    countryCode: 'US',
    latitude: 25.7743,
    longitude: -80.1937,
    timezone: 'America/New_York',
    admin: 'Florida',
  },
  {
    id: 'tokyo',
    name: 'Tokyo',
    country: 'Japan',
    countryCode: 'JP',
    latitude: 35.6762,
    longitude: 139.6503,
    timezone: 'Asia/Tokyo',
  },
  {
    id: 'london',
    name: 'London',
    country: 'United Kingdom',
    countryCode: 'GB',
    latitude: 51.5085,
    longitude: -0.1257,
    timezone: 'Europe/London',
  },
];
// City examples from the top three countries in the 2026 WorldRiskIndex.
// The index does not rank these cities or describe current warning conditions.
const RISK_STUDY_LOCATIONS: Place[] = [
  {
    id: '1701668',
    name: 'Manila',
    country: 'Philippines',
    countryCode: 'PH',
    latitude: 14.6042,
    longitude: 120.9822,
    timezone: 'Asia/Manila',
    admin: 'National Capital Region',
  },
  {
    id: '1275004',
    name: 'Kolkata',
    country: 'India',
    countryCode: 'IN',
    latitude: 22.56263,
    longitude: 88.36304,
    timezone: 'Asia/Kolkata',
    admin: 'West Bengal',
  },
  {
    id: '1642911',
    name: 'Jakarta',
    country: 'Indonesia',
    countryCode: 'ID',
    latitude: -6.21462,
    longitude: 106.84513,
    timezone: 'Asia/Jakarta',
    admin: 'Jakarta Special Capital Region',
  },
];
type Resource<T> = { data: T | null; loading: boolean; error: string | null };
function useResource<T>(
  place: Place,
  revision: number,
  loader: (p: Place, s?: AbortSignal) => Promise<T>,
  enabled = true,
): Resource<T> {
  const key = `${place.latitude},${place.longitude},${place.countryCode}`;
  const [state, setState] = useState<Resource<T> & { key: string; loader: typeof loader }>({
    data: null,
    loading: true,
    error: null,
    key,
    loader,
  });
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    if (!enabled) {
      setState({ data: null, loading: false, error: null, key, loader });
      return () => controller.abort();
    }
    setState({ data: null, loading: true, error: null, key, loader });
    loader(place, controller.signal)
      .then((data) => {
        if (active) setState({ data, loading: false, error: null, key, loader });
      })
      .catch((e) => {
        if (active && !controller.signal.aborted)
          setState({
            data: null,
            loading: false,
            error: e instanceof Error ? e.message : 'The data provider is unavailable.',
            key,
            loader,
          });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [place.latitude, place.longitude, place.countryCode, revision, loader, enabled]);
  return enabled && state.key === key && state.loader === loader
    ? state
    : { data: null, loading: enabled, error: null };
}
function WeatherIcon({ code, size = 24 }: { code: number | null | undefined; size?: number }) {
  return code == null ? (
    <CircleHelp size={size} />
  ) : [71, 73, 75, 77, 85, 86].includes(code) ? (
    <CloudSnow size={size} />
  ) : code >= 95 ? (
    <CloudLightning size={size} />
  ) : code != null && code >= 51 ? (
    <CloudRain size={size} />
  ) : code != null && code > 1 ? (
    <Cloud size={size} />
  ) : (
    <Sun size={size} />
  );
}
function ErrorNote({ error }: { error: string | null }) {
  return error ? (
    <p className="error-note" role="status">
      <TriangleAlert size={15} />
      {error}
    </p>
  ) : null;
}
function PanelHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="panel-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      {children}
    </div>
  );
}

function ForecastChart({
  hours,
  models,
  timezone,
}: {
  hours: Hour[];
  models: ModelForecast[];
  timezone: string;
}) {
  const [metric, setMetric] = useState<'temperature' | 'precipitation' | 'wind'>('temperature');
  const [range, setRange] = useState(24);
  const selected = hours.slice(0, range);
  const label =
    metric === 'temperature' ? 'Temperature' : metric === 'precipitation' ? 'Rainfall' : 'Wind';
  const unit = metric === 'temperature' ? '°C' : metric === 'precipitation' ? 'mm' : 'km/h';
  const all = [
    selected.map((h) => h[metric]),
    ...models.map((m) =>
      selected.map((h) => m.hours.find((t) => t.time === h.time)?.[metric] ?? null),
    ),
  ];
  const nums = all.flat().filter(finite);
  const lo = Math.floor(Math.min(...nums, metric === 'temperature' ? Infinity : 0));
  const hi = Math.ceil(Math.max(...nums));
  const min = Number.isFinite(lo) ? lo : 0,
    max = Number.isFinite(hi) ? Math.max(hi, min + 1) : 1;
  return (
    <>
      <div className="chart-tools">
        <div className="segmented" role="group" aria-label="Chart metric">
          {(['temperature', 'precipitation', 'wind'] as const).map((m) => (
            <button
              key={m}
              aria-pressed={metric === m}
              className={metric === m ? 'selected' : ''}
              onClick={() => setMetric(m)}
            >
              {m === 'temperature' ? 'Temperature' : m === 'precipitation' ? 'Rainfall' : 'Wind'}
            </button>
          ))}
        </div>
        <div className="segmented compact" role="group" aria-label="Forecast duration">
          {[24, 72].map((h) => (
            <button
              key={h}
              aria-pressed={range === h}
              className={range === h ? 'selected' : ''}
              onClick={() => setRange(h)}
            >
              {h}h
            </button>
          ))}
        </div>
      </div>
      <div className="chart-wrap">
        <div className="chart-scale">
          <span>
            {value(max)}
            {unit}
          </span>
          <span>
            {value((max + min) / 2)}
            {unit}
          </span>
          <span>
            {value(min)}
            {unit}
          </span>
        </div>
        <div className="chart-svg">
          <svg
            viewBox="0 0 600 160"
            preserveAspectRatio="none"
            role="img"
            aria-label={`${label} forecast over ${range} hours. The table below contains exact values.`}
          >
            <defs>
              <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#65dbc6" stopOpacity=".2" />
                <stop offset="100%" stopColor="#65dbc6" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0, 70, 140].map((y) => (
              <line
                key={y}
                x1="0"
                x2="600"
                y1={y + 10}
                y2={y + 10}
                stroke="#29353c"
                strokeDasharray="3 5"
              />
            ))}
            <g transform="translate(0 10)">
              {all.map((series, i) => (
                <path
                  key={i}
                  d={chartPaths(series, min, max)}
                  fill="none"
                  stroke={['#77e5d1', '#ffb65d', '#9490f8'][i]}
                  strokeWidth={i === 0 ? 2.8 : 1.8}
                  strokeDasharray={i === 0 ? undefined : '5 4'}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </g>
          </svg>
          <div className="chart-times">
            {[
              0,
              Math.floor(selected.length / 3),
              Math.floor((2 * selected.length) / 3),
              selected.length - 1,
            ]
              .filter((v, i, a) => a.indexOf(v) === i && v >= 0)
              .map((i) => (
                <span key={i}>
                  {selected[i]
                    ? localTime(selected[i].time, timezone, {
                        hour: '2-digit',
                        day: '2-digit',
                        month: 'short',
                      })
                    : '—'}
                </span>
              ))}
          </div>
        </div>
      </div>
      <div className="chart-legend">
        <span>
          <i className="dot mint" />
          Local forecast
        </span>
        {models.map((m, i) => (
          <span key={m.id}>
            <i className={`dot ${i === 0 ? 'amber' : 'violet'}`} />
            {m.name}
          </span>
        ))}
      </div>
      <details className="data-details">
        <summary>
          Explore hourly data <ChevronDown size={14} />
        </summary>
        <div className="table-scroll">
          <table>
            <caption>
              {label} ({unit}) · {timezone}
            </caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Local forecast</th>
                {models.map((m) => (
                  <th key={m.id} scope="col">
                    {m.name}
                  </th>
                ))}
                <th scope="col">Rain chance</th>
              </tr>
            </thead>
            <tbody>
              {selected.map((h) => (
                <tr key={h.time}>
                  <th scope="row">
                    {localTime(h.time, timezone, {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                    })}
                  </th>
                  <td>{value(h[metric], 1)}</td>
                  {models.map((m) => (
                    <td key={m.id}>{value(m.hours.find((x) => x.time === h.time)?.[metric], 1)}</td>
                  ))}
                  <td>{value(h.probability)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

export default function App() {
  const [place, setPlace] = useState<Place>(PRESETS[0]);
  const [revision, setRevision] = useState(0);
  const [alertRevision, setAlertRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [mobileNav, setMobileNav] = useState(false);
  const [narrow, setNarrow] = useState(window.innerWidth <= 800);
  const [active, setActive] = useState('overview');
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>(() => {
    try {
      return readConnectionMode(localStorage.getItem(CONNECTION_KEY));
    } catch {
      return 'lite';
    }
  });
  const [online, setOnline] = useState(navigator.onLine);
  const policy = networkPolicy(connectionMode, online);
  const lowBandwidth = !policy.extras;
  const [saved, setSaved] = useState<Place[]>(() => {
    try {
      return readPlaces(localStorage.getItem('stormsignal:places'));
    } catch {
      return [];
    }
  });
  const [toast, setToast] = useState('');
  const [geoBusy, setGeoBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [notifications, setNotifications] = useState(false);
  const [offlineStatus, setOfflineStatus] = useState('Checking offline availability');
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) {
      setOfflineStatus('Download the kit for offline use');
      return;
    }
    let active = true;
    let timeout: ReturnType<typeof setTimeout>;
    let channel: MessageChannel | undefined;
    const unconfirmed = () => {
      if (active) setOfflineStatus('Offline cache unconfirmed · download the kit');
    };
    const confirmCache = (worker?: ServiceWorker | null) => {
      clearTimeout(timeout);
      channel?.port1.close();
      timeout = setTimeout(unconfirmed, 5000);
      if (!worker) return;
      channel = new MessageChannel();
      channel.port1.onmessage = (event) => {
        if (!active || event.data?.type !== 'STORMSIGNAL_OFFLINE_STATUS') return;
        clearTimeout(timeout);
        setOfflineStatus(
          event.data.ready === true
            ? 'Offline interface and kit saved on this device'
            : 'Offline cache incomplete · download the kit',
        );
        channel?.port1.close();
      };
      worker.postMessage({ type: 'STORMSIGNAL_OFFLINE_STATUS' }, [channel.port2]);
    };
    const controllerChanged = () => confirmCache(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', controllerChanged);
    timeout = setTimeout(unconfirmed, 10000);
    navigator.serviceWorker
      .register('/sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => {
        if (active) confirmCache(registration.active);
      })
      .catch(unconfirmed);
    return () => {
      active = false;
      clearTimeout(timeout);
      channel?.port1.close();
      navigator.serviceWorker.removeEventListener('controllerchange', controllerChanged);
    };
  }, []);
  const alerted = useRef(new Set<string>());
  const searchArea = useRef<HTMLDivElement>(null);
  const forecast = useResource<Forecast>(
    place,
    revision,
    lowBandwidth ? fetchCompactForecast : fetchForecast,
    policy.essentials,
  );
  const models = useResource<ModelForecast[]>(place, revision, fetchModels, policy.extras);
  const air = useResource<AirQuality>(place, revision, fetchAirQuality, policy.extras);
  const alerts = useResource<AlertResult>(
    place,
    revision + alertRevision,
    fetchAlerts,
    policy.essentials,
  );
  const tz = forecast.data?.timezone || place.timezone || 'UTC';
  const f = forecast.data;
  const hours = f?.hours.filter((h) => h.time >= now - 1800000) || [];
  const hazards = f ? deriveHazards(f, now) : [];
  const isStale = !!f && (now - f.fetchedAt > FORECAST_STALE_MS || f.fetchedAt > now + 300000);
  const outlook = getOutlook(isStale ? [] : hours, now);
  const alertsRecent = alertCheckIsRecent(alerts.data?.fetchedAt, now, policy.essentials);
  const activeAlerts = alertsRecent ? alerts.data?.alerts.filter((a) => a.expires > now) || [] : [];
  const spread = modelSpread(models.data || [], hours.slice(0, 24));
  const selectedSaved = saved.some(
    (p) =>
      Math.abs(p.latitude - place.latitude) < 0.01 &&
      Math.abs(p.longitude - place.longitude) < 0.01,
  );
  const currentStale = f ? isStale || now - f.current.time > 2 * 3600000 : false;
  useEffect(() => {
    const resize = () => setNarrow(window.innerWidth <= 800);
    window.addEventListener('resize', resize);
    const update = () => {
      setOnline(navigator.onLine);
      setNow(Date.now());
    };
    const resume = () => {
      if (document.visibilityState === 'visible') {
        setNow(Date.now());
        if (navigator.onLine && connectionMode === 'full') {
          setAlertRevision((v) => v + 1);
          setRevision((v) => v + 1);
        }
      }
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    const clock = setInterval(() => {
      setNow(Date.now());
      if (connectionMode === 'full' && navigator.onLine && document.visibilityState === 'visible')
        setAlertRevision((v) => v + 1);
    }, 60000);
    const refresh = setInterval(() => {
      if (connectionMode === 'full' && navigator.onLine && document.visibilityState === 'visible')
        setRevision((v) => v + 1);
    }, 15 * 60000);
    return () => {
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      clearInterval(clock);
      clearInterval(refresh);
    };
  }, [connectionMode]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 6000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!policy.essentials || query.trim().length < 2) {
      setResults([]);
      setSearchError('');
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    setResults([]);
    const timer = setTimeout(() => {
      searchPlaces(query.trim(), controller.signal)
        .then((r) => {
          if (controller.signal.aborted) return;
          setResults(r);
          setSearchError(r.length ? '' : 'No matching places. Try a nearby city.');
        })
        .catch((e) => {
          if (!controller.signal.aborted)
            setSearchError(e instanceof Error ? e.message : 'Search unavailable');
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, policy.essentials]);
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (searchArea.current && !searchArea.current.contains(e.target as Node)) {
        setQuery('');
        setResults([]);
      }
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  useEffect(() => {
    if (
      !notifications ||
      !policy.polling ||
      !alertsRecent ||
      !alerts.data ||
      alerts.data.status !== 'available' ||
      alerts.data.partial ||
      alerts.data.scope !== 'point' ||
      !('Notification' in window) ||
      Notification.permission !== 'granted'
    )
      return;
    for (const alert of alerts.data.alerts) {
      if (alert.expires <= Date.now() || alerted.current.has(alert.id)) continue;
      alerted.current.add(alert.id);
      try {
        new Notification(`${alert.event} · ${place.name}`, {
          body: `${alert.severity} · ${alert.area}. Open StormSignal for official instructions.`,
          tag: alert.id,
        });
      } catch {
        setNotifications(false);
        setToast('Notifications are unavailable in this browser.');
      }
    }
  }, [notifications, alerts.data, place.name, policy.polling, alertsRecent]);
  function changeConnectionMode(mode: ConnectionMode) {
    setConnectionMode(mode);
    setQuery('');
    setNotifications(false);
    try {
      localStorage.setItem(CONNECTION_KEY, mode);
    } catch {
      setToast('This setting applies now, but browser storage could not remember it.');
    }
  }
  function selectPlace(p: Place) {
    setPlace(p);
    setQuery('');
    setResults([]);
    setSearchError('');
    setMobileNav(false);
  }
  function savePlace() {
    const next = selectedSaved
      ? saved.filter(
          (p) =>
            Math.abs(p.latitude - place.latitude) >= 0.01 ||
            Math.abs(p.longitude - place.longitude) >= 0.01,
        )
      : [place, ...saved].slice(0, 8);
    try {
      localStorage.setItem('stormsignal:places', JSON.stringify(next));
      setSaved(next);
      setToast(selectedSaved ? 'Place removed.' : 'Place saved on this device.');
    } catch {
      setToast('Device storage is unavailable. The place was not saved.');
    }
  }
  function locate() {
    if (!navigator.geolocation) {
      setToast('Location is unavailable. Search for your city instead.');
      return;
    }
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        selectPlace({
          id: `geo-${pos.coords.latitude}-${pos.coords.longitude}`,
          name: 'My location',
          country: 'Search a named city for regional alert coverage',
          countryCode: '',
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        });
        setGeoBusy(false);
      },
      () => {
        setGeoBusy(false);
        setToast('Location access failed. Search for a city instead.');
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  }
  async function enableNotifications() {
    if (notifications) {
      setNotifications(false);
      return;
    }
    if (!('Notification' in window)) {
      setToast('This browser does not support desktop notifications.');
      return;
    }
    try {
      const allowed = await Notification.requestPermission();
      setNotifications(allowed === 'granted');
      setToast(
        allowed === 'granted'
          ? 'Alerts enabled while this page stays open. Check official channels too.'
          : 'Notification permission was not granted.',
      );
    } catch {
      setToast('Notifications are unavailable.');
    }
  }
  const nav = [
    ['overview', Compass, 'Overview'],
    ['forecast', Activity, 'Forecast lab'],
    ['satellite', Satellite, 'Satellite'],
    ['alerts', ShieldCheck, 'Official alerts'],
    ['regional-reports', Globe2, 'Disaster reports'],
    ['readiness', Bookmark, 'Preparedness'],
    ['offline-briefings', WifiOff, 'Saved briefings'],
    ['sources', Database, 'Data & sources'],
  ] as const;
  return (
    <div className={`app-shell ${lowBandwidth ? 'field-mode' : ''}`}>
      <a className="skip-link" href="#main">
        Skip to weather dashboard
      </a>
      <aside
        id="side-menu"
        inert={narrow && !mobileNav}
        className={`sidebar ${mobileNav ? 'open' : ''}`}
      >
        <a className="brand" href="#overview" aria-label="StormSignal home">
          <span className="brand-mark">
            <Radio size={25} />
          </span>
          <span>
            storm<span className="brand-light">signal</span>
            <small>WEATHER WITH EVIDENCE</small>
          </span>
        </a>
        <button
          className="mobile-close icon-button"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        >
          <X />
        </button>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {nav
            .filter(
              ([id]) =>
                (policy.extras || !['forecast', 'satellite', 'regional-reports'].includes(id)) &&
                (policy.essentials || id !== 'alerts'),
            )
            .map(([id, Icon, label]) => (
              <a
                key={id}
                href={`#${id}`}
                onClick={() => {
                  setActive(id);
                  setMobileNav(false);
                }}
                className={active === id ? 'active' : ''}
              >
                <Icon size={18} />
                {label}
                {id === 'alerts' && !!activeAlerts.length && (
                  <span className="nav-count">{activeAlerts.length}</span>
                )}
              </a>
            ))}
        </nav>
        <div className="sidebar-divider" />
        {[
          { label: 'Quick locations', places: PRESETS, riskStudy: false },
          { label: 'Risk study locations', places: RISK_STUDY_LOCATIONS, riskStudy: true },
          { label: 'Saved places', places: saved, riskStudy: false },
        ]
          .filter((group) => group.places.length)
          .map((group) => (
            <section className="location-group" aria-label={group.label} key={group.label}>
              <div className="nav-label">
                {group.label.toUpperCase()} <Globe2 size={13} />
              </div>
              {group.riskStudy && (
                <p className="location-context">
                  City examples from the three highest-risk countries in the 2026 WorldRiskIndex.
                </p>
              )}
              <div className="saved-list">
                {group.places.map((p, index) => {
                  const selected =
                    Math.abs(p.latitude - place.latitude) < 0.01 &&
                    Math.abs(p.longitude - place.longitude) < 0.01;
                  return (
                    <button
                      key={p.id}
                      className={selected ? 'current' : ''}
                      aria-pressed={selected}
                      onClick={() => selectPlace(p)}
                    >
                      <MapPin size={14} />
                      <span>
                        {p.name}
                        <small>
                          {p.country}
                          {group.riskStudy && ` · country #${index + 1}`}
                        </small>
                      </span>
                      {selected && <i className="location-dot" />}
                    </button>
                  );
                })}
              </div>
              {group.riskStudy && (
                <details className="location-context risk-context">
                  <summary>About this selection</summary>
                  <p>
                    The index measures long-term national exposure and vulnerability. These cities
                    are examples, not the world's three highest-risk cities. This is separate from
                    live weather warnings.
                  </p>
                  <a
                    href="https://www.welthungerhilfe.org/news/publications/detail/worldriskreport-2026"
                    target="_blank"
                    rel="noreferrer"
                  >
                    WorldRiskReport 2026 ↗
                  </a>
                  <p>
                    Bündnis Entwicklung Hilft / IFHV ·{' '}
                    <a
                      href="https://creativecommons.org/licenses/by/4.0/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      CC BY 4.0
                    </a>
                  </p>
                </details>
              )}
            </section>
          ))}
        <div className="sidebar-bottom">
          <div className="source-stamp">
            <i className="dot mint" /> Open data. Clear limits.
          </div>
          <p>Independent situational awareness. Always follow local authorities.</p>
          <a href="https://github.com/TARUNTEjjjj/stormsignal" target="_blank" rel="noreferrer">
            <Code2 size={15} /> Open-source project <ArrowUpRight size={13} />
          </a>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button
            className="mobile-menu icon-button"
            aria-label="Open navigation"
            aria-controls="side-menu"
            aria-expanded={mobileNav}
            onClick={() => setMobileNav(true)}
          >
            <Menu size={22} />
          </button>
          <div className="breadcrumb">
            Workspace <span>/</span>{' '}
            <strong>{lowBandwidth ? 'Field essentials' : 'Weather overview'}</strong>
          </div>
          <div className="search-area" ref={searchArea}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!searching && results[0]) selectPlace(results[0]);
              }}
              role="search"
            >
              <Search size={17} />
              <input
                aria-label="Search any city"
                value={query}
                placeholder="Search any city…"
                disabled={!policy.essentials}
                title={
                  !policy.essentials
                    ? 'Search needs a connection. Use saved or quick locations instead.'
                    : undefined
                }
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setQuery('');
                    setResults([]);
                  }
                }}
                autoComplete="off"
              />
              <kbd>↵</kbd>
            </form>
            {query.trim().length >= 2 && (
              <div className="search-results" aria-live="polite">
                {searching && <p>Searching places…</p>}
                {searchError && <p>{searchError}</p>}
                {results.map((p) => (
                  <button key={p.id} onClick={() => selectPlace(p)}>
                    <MapPin size={16} />
                    <span>
                      {p.name}
                      <small>{[p.admin, p.country].filter(Boolean).join(', ')}</small>
                    </span>
                    <ArrowUpRight size={14} />
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="status-tag">
            <i className={`dot ${policy.essentials ? 'mint' : 'amber'}`} />
            {!policy.essentials ? 'OFFLINE MODE' : 'NETWORK AVAILABLE'}
          </span>
          <button
            className="icon-button locate"
            aria-label="Use my location"
            onClick={locate}
            disabled={geoBusy}
          >
            <LocateFixed size={20} />
          </button>
        </header>
        <main id="main">
          <section className="page-heading" id="overview">
            <div>
              <div className="eyebrow location-eyebrow">
                <MapPin size={13} />
                {place.country || 'Selected coordinates'} <span> / </span>
                {localTime(now, tz, { day: '2-digit', month: 'long', year: 'numeric' })}
              </div>
              <h1>
                {place.name}
                <span className="heading-dot">.</span>
              </h1>
              <p>Your local conditions. The bigger picture.</p>
            </div>
            <div className="heading-actions">
              <button className="secondary-button" onClick={savePlace}>
                <Bookmark size={15} fill={selectedSaved ? 'currentColor' : 'none'} />
                {selectedSaved ? 'Saved' : 'Save place'}
              </button>
              <button
                className="primary-button"
                onClick={() => {
                  clearRequestCache();
                  setRevision((x) => x + 1);
                  setNow(Date.now());
                }}
                disabled={forecast.loading || !policy.essentials}
              >
                <RefreshCw size={15} className={forecast.loading ? 'spin' : ''} />
                {forecast.loading ? 'Updating' : 'Refresh data'}
              </button>
            </div>
          </section>
          <section className="field-controls panel" aria-labelledby="field-heading">
            <div>
              <span className="eyebrow">BUILT FOR PATCHY SIGNAL</span>
              <h2 id="field-heading">Keep the essentials close.</h2>
              <p>
                {connectionMode === 'offline'
                  ? 'Live data requests are paused. Use saved briefings and your emergency kit. External source links still need a connection.'
                  : connectionMode === 'lite'
                    ? 'A small 24-hour forecast and official alert checks. No maps, satellite downloads, extra feeds, or background polling. Refresh when you need an update.'
                    : 'Full workspace with imagery, comparison models, air quality, regional reports, and automatic refreshes.'}
              </p>
            </div>
            <div className="connection-options" role="group" aria-label="Connection mode">
              {(
                [
                  ['lite', 'Data saver'],
                  ['offline', 'Offline only'],
                  ['full', 'Full workspace'],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={connectionMode === mode}
                  onClick={() => changeConnectionMode(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="field-shortcuts">
              {policy.essentials && <a href="#alerts">Official warnings ↓</a>}
              <a href="#offline-briefings">Saved briefings ↓</a>
              <a href="/offline.html">Open emergency kit ↗</a>
              <a href="/offline.html" download="StormSignal-offline-kit.html">
                Download offline-only kit ↓
              </a>
            </div>
            <p className="field-cache-status" role="status">
              {offlineStatus}. Download the kit before losing service. This app cannot receive new
              warnings offline.
            </p>
          </section>
          {!policy.essentials && (
            <div className="wide-notice">
              <WifiOff size={18} />
              <span>
                {online ? 'Offline-only mode is on.' : 'The browser reports no network connection.'}{' '}
                Weather and warnings cannot refresh. Saved material is historical, never an
                all-clear. <a href="/offline.html">Open your emergency kit</a>.
              </span>
            </div>
          )}
          {policy.essentials && (
            <>
              <div className="overview-grid">
                <section className="conditions-card" aria-busy={forecast.loading}>
                  <div className="card-kicker">
                    <span>
                      <i className="dot mint" /> CURRENT MODEL ESTIMATE
                    </span>
                    <span>
                      {f
                        ? localTime(f.current.time, tz)
                        : forecast.loading
                          ? 'Loading…'
                          : 'Unavailable'}
                    </span>
                  </div>
                  <div className="temperature">
                    <span>
                      {value(f?.current.temperature)}
                      <sup>°</sup>
                    </span>
                    <div className="weather-glyph">
                      {f?.current.code != null &&
                      f.current.code <= 1 &&
                      f.days[0]?.sunrise &&
                      f.days[0]?.sunset &&
                      (f.current.time < f.days[0].sunrise || f.current.time > f.days[0].sunset) ? (
                        <Moon size={67} />
                      ) : (
                        <WeatherIcon code={f?.current.code} size={67} />
                      )}
                    </div>
                  </div>
                  <div className="condition-name">
                    {f
                      ? weatherLabel(f.current.code)
                      : forecast.error
                        ? 'Weather unavailable'
                        : 'Getting the forecast…'}
                  </div>
                  <div className="feels">
                    Feels like {value(f?.current.apparent)}°C <span>·</span> {tz}
                  </div>
                  <ErrorNote error={forecast.error} />
                  {currentStale && (
                    <p className="error-note">
                      Weather data is stale. Refresh or check official sources.
                    </p>
                  )}
                  <div className="condition-metrics">
                    <div>
                      <Wind size={17} />
                      <span>
                        Wind
                        <strong>
                          {value(f?.current.wind)} <small>km/h</small>
                        </strong>
                      </span>
                    </div>
                    <div>
                      <Droplets size={17} />
                      <span>
                        Humidity
                        <strong>
                          {value(f?.current.humidity)}
                          <small>%</small>
                        </strong>
                      </span>
                    </div>
                    <div>
                      <CloudRain size={17} />
                      <span>
                        Precipitation
                        <strong>
                          {value(f?.current.precipitation, 1)} <small>mm</small>
                        </strong>
                      </span>
                    </div>
                    {policy.extras && (
                      <div>
                        <Eye size={17} />
                        <span>
                          US AQI
                          <strong>
                            {value(air.data?.usAqi)}{' '}
                            <small>
                              {air.data &&
                              (now - air.data.fetchedAt > 3600000 ||
                                now - air.data.time > 3 * 3600000)
                                ? 'stale'
                                : 'modeled'}
                            </small>
                          </strong>
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="condition-footer">
                    <span>Fetched {f ? age(f.fetchedAt, now) : '—'}</span>
                    <a href="#sources">
                      Source details <ArrowUpRight size={12} />
                    </a>
                  </div>
                </section>
                <section className="map-card" id="satellite">
                  <div className="map-card-header">
                    <span>
                      <Satellite size={15} />{' '}
                      {policy.extras ? 'SATELLITE EXPLORER' : 'COMPACT FORECAST'}
                    </span>
                    <span className="mono">
                      {place.latitude.toFixed(2)}° / {place.longitude.toFixed(2)}°
                    </span>
                  </div>
                  {policy.extras ? (
                    <OptionalPanel
                      label="Satellite explorer"
                      onUseEssentials={() => changeConnectionMode('lite')}
                    >
                      <WeatherMap
                        place={place}
                        alerts={activeAlerts}
                        lowBandwidth={lowBandwidth}
                        onSelect={selectPlace}
                      />
                    </OptionalPanel>
                  ) : (
                    <div className="field-forecast">
                      <h2>Next hours, at a glance.</h2>
                      <p>Model estimates · {tz}. Times are for the selected place.</p>
                      {hours.length ? (
                        <div className="table-scroll">
                          <table>
                            <caption>
                              Next 12 hours · refreshed {f ? age(f.fetchedAt, now) : '—'}
                            </caption>
                            <thead>
                              <tr>
                                <th>Time</th>
                                <th>°C</th>
                                <th>Rain mm</th>
                                <th>Gust km/h</th>
                              </tr>
                            </thead>
                            <tbody>
                              {hours.slice(0, 12).map((hour) => (
                                <tr key={hour.time}>
                                  <th scope="row">
                                    <time dateTime={new Date(hour.time).toISOString()}>
                                      {localTime(hour.time, tz, { day: '2-digit', month: 'short' })}
                                      <br />
                                      {localTime(hour.time, tz, {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        timeZoneName: 'short',
                                      })}
                                    </time>
                                  </th>
                                  <td>{value(hour.temperature)}</td>
                                  <td>{value(hour.precipitation, 1)}</td>
                                  <td>{value(hour.gust)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p>
                          {forecast.loading
                            ? 'Fetching the compact forecast…'
                            : 'Forecast unavailable. Use official information and saved material.'}
                        </p>
                      )}
                      <p className="fine-print">
                        The compact forecast requests 24 hourly steps instead of a full week. Maps
                        and model comparisons load only in Full workspace.
                      </p>
                    </div>
                  )}
                </section>
              </div>
              <section
                className={`signal-strip signal-${outlook.level}`}
                aria-label="Forecast signals"
              >
                <div className="signal-title">
                  <span className="signal-icon">
                    <Activity size={20} />
                  </span>
                  <div>
                    <span className="eyebrow">NEXT 24 HOURS</span>
                    <strong>{f ? outlook.title : 'Forecast pending'}</strong>
                  </div>
                </div>
                <p>
                  {f ? outlook.detail : 'Signals appear once fresh forecast data is available.'}
                </p>
                <a href="#alerts">
                  Check official warnings <ArrowRight size={15} />
                </a>
              </section>
              {policy.extras && (
                <div className="analytics-grid">
                  <section className="panel forecast-panel" id="forecast">
                    <PanelHeader eyebrow="LOOK AHEAD" title="One forecast. Multiple perspectives.">
                      <span className="panel-number">01</span>
                    </PanelHeader>
                    {hours.length ? (
                      <ForecastChart hours={hours} models={models.data || []} timezone={tz} />
                    ) : (
                      <div className="empty-state">
                        <Activity size={30} />
                        <p>
                          {forecast.loading
                            ? 'Building your forecast timeline…'
                            : 'Forecast unavailable. Try refreshing or choosing another place.'}
                        </p>
                      </div>
                    )}
                    <ErrorNote error={models.error} />
                    <div className="model-note">
                      <Layers size={16} />
                      <p>
                        {spread === null ? (
                          'Model comparison appears when both model forecasts are available.'
                        ) : (
                          <>
                            Up to <strong>{value(spread, 1)}°C</strong> difference between models
                            over the next 24 hours.
                          </>
                        )}{' '}
                        <span>
                          Model spread shows disagreement, not a calibrated confidence interval.
                        </span>
                      </p>
                    </div>
                  </section>
                  <section className="panel outlook-panel">
                    <PanelHeader eyebrow="THE WEEK AHEAD" title="7-day outlook" />
                    <div className="daily-list">
                      {f?.days.map((day, i) => (
                        <div className="day-row" key={day.time}>
                          <span>
                            {localTime(day.time, tz, {
                              year: 'numeric',
                              month: '2-digit',
                              day: '2-digit',
                            }) ===
                            localTime(now, tz, {
                              year: 'numeric',
                              month: '2-digit',
                              day: '2-digit',
                            })
                              ? 'Today'
                              : localTime(day.time, tz, { weekday: 'short' })}
                          </span>
                          <WeatherIcon code={day.code} size={20} />
                          <span className="day-rain">
                            <Droplets size={11} />
                            {value(day.probability)}%
                          </span>
                          <strong>{value(day.high)}°</strong>
                          <span className="day-low">{value(day.low)}°</span>
                        </div>
                      )) || <p className="muted">Waiting for daily forecast…</p>}
                    </div>
                    <div className="sun-times">
                      <span>
                        <Sun size={16} /> Sunrise{' '}
                        <strong>
                          {f?.days[0]?.sunrise ? localTime(f.days[0].sunrise, tz) : '—'}
                        </strong>
                      </span>
                      <span>
                        <ArrowDown size={16} /> Sunset{' '}
                        <strong>
                          {f?.days[0]?.sunset ? localTime(f.days[0].sunset, tz) : '—'}
                        </strong>
                      </span>
                    </div>
                  </section>
                </div>
              )}
              <div className="safety-grid">
                <section className="panel alerts-panel" id="alerts">
                  <PanelHeader eyebrow="KNOW WHAT’S OFFICIAL" title="Warnings & local guidance">
                    <ShieldCheck size={22} className="mint-text" />
                  </PanelHeader>
                  <div
                    className={`coverage-banner ${alerts.data?.status === 'available' ? 'available' : ''} ${alerts.data?.partial ? 'partial' : ''}`}
                  >
                    <Radio size={17} />
                    <div>
                      <strong>
                        {alerts.loading
                          ? 'Checking official alert coverage…'
                          : alerts.error
                            ? 'Alert feed unavailable'
                            : alerts.data?.status === 'available'
                              ? alerts.data.source
                              : 'Official feed not integrated here'}
                      </strong>
                      <p>
                        {alerts.data?.coverage ||
                          'Do not assume there are no warnings when this feed is unavailable.'}
                      </p>
                    </div>
                  </div>
                  {alerts.data?.scopeLabel && (
                    <p className="warning-scope">
                      <strong>
                        {alerts.data.scope === 'region'
                          ? 'Regional bulletins'
                          : alerts.data.scope === 'country'
                            ? 'Country bulletins'
                            : 'Point lookup'}
                        : {alerts.data.scopeLabel}
                      </strong>
                      {alerts.data.partial && (
                        <span>
                          Incomplete coverage · check the named affected areas and official source.
                        </span>
                      )}
                      {alerts.data.feedUpdatedAt && (
                        <span>
                          Latest bulletin in {alerts.data.checks ? 'checked feeds' : 'feed'}:{' '}
                          {localTime(alerts.data.feedUpdatedAt, tz, {
                            day: '2-digit',
                            month: 'short',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                          . This is an issue time, not a feed-health guarantee.
                        </span>
                      )}
                    </p>
                  )}
                  <ErrorNote error={alerts.error} />
                  {!!alerts.data?.checks?.length && (
                    <details className="source-checks">
                      <summary>
                        Source checks ·{' '}
                        {alerts.data.checks.filter((check) => check.status === 'available').length}/
                        {alerts.data.checks.length} retrieved
                        {alerts.data.checks.some((check) => check.status !== 'available') &&
                          ' · missing source'}
                      </summary>
                      <p>
                        Retrieval confirms a response, not complete coverage or safe conditions.
                      </p>
                      <ul>
                        {alerts.data.checks.map((check) => (
                          <li key={check.id}>
                            <a href={check.url} target="_blank" rel="noreferrer">
                              {check.name} ↗
                            </a>
                            <strong
                              className={check.status === 'available' ? '' : 'source-missing'}
                            >
                              {check.status === 'available'
                                ? `Retrieved ${age(check.fetchedAt!, now)}`
                                : 'Could not verify'}
                            </strong>
                            <p>{check.coverage}</p>
                            {check.feedUpdatedAt && (
                              <small>
                                Latest source bulletin:{' '}
                                {localTime(check.feedUpdatedAt, tz, {
                                  day: '2-digit',
                                  month: 'short',
                                  year: 'numeric',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </small>
                            )}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {alerts.data?.status === 'available' && !alertsRecent && (
                    <p className="wide-notice" role="status">
                      This alert check is more than two minutes old. Current warning status is
                      unverified. Refresh data or use the official source; saved briefings remain
                      historical.
                    </p>
                  )}
                  {activeAlerts.map((alert) => (
                    <details
                      className="official-alert"
                      key={alert.id}
                      open={alert.severity === 'Extreme'}
                    >
                      <summary>
                        <TriangleAlert size={18} />
                        <span>
                          <strong>{alert.event}</strong>
                          <small>
                            {alert.severity} · Bulletin valid to{' '}
                            {localTime(alert.expires, tz, {
                              day: '2-digit',
                              month: 'short',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </small>
                        </span>
                        <ChevronDown size={16} />
                      </summary>
                      <div className="alert-body">
                        <p>{alert.title}</p>
                        <p className="muted">{alert.area}</p>
                        <h3>Official instructions</h3>
                        <p className="preserve-lines">
                          {alert.instruction ||
                            'Read the issuing authority’s full bulletin for instructions.'}
                        </p>
                        <details>
                          <summary>Full description</summary>
                          <p className="preserve-lines">{alert.description}</p>
                        </details>
                        <p className="muted">
                          Issued{' '}
                          {localTime(alert.sent, tz, {
                            day: '2-digit',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}{' '}
                          · {alert.source}
                        </p>
                        <a href={alert.url} target="_blank" rel="noreferrer">
                          Read official bulletin <ExternalLink size={13} />
                        </a>
                      </div>
                    </details>
                  ))}
                  {alertsRecent && alerts.data?.status === 'available' && !activeAlerts.length && (
                    <p className="empty-alert">
                      {alerts.data.partial || alerts.data.scope !== 'point'
                        ? 'No unexpired bulletins were matched in this limited feed. Current warning status is not confirmed; check the official sources below.'
                        : 'No active alerts returned for this point. Conditions can change; this is not an assurance of safety.'}
                    </p>
                  )}
                  <div className="alert-actions">
                    <a
                      className="text-link"
                      href={alerts.data?.officialUrl || warningSourceFallback(place)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Visit official warning source <ArrowUpRight size={15} />
                    </a>
                    <button
                      className="quiet-button"
                      onClick={enableNotifications}
                      disabled={
                        alerts.data?.status !== 'available' ||
                        alerts.data.partial ||
                        alerts.data.scope !== 'point' ||
                        !policy.polling
                      }
                    >
                      <Bell size={14} />
                      {notifications ? 'Disable alerts' : 'Enable page alerts'}
                    </button>
                  </div>
                  {!!localWarningSources(place).length && (
                    <div className="regional-warning-links">
                      <span>Check the local authority directly (internet required):</span>
                      {localWarningSources(place).map(({ label, url }) => (
                        <a key={url} href={url} target="_blank" rel="noreferrer">
                          {label} ↗
                        </a>
                      ))}
                    </div>
                  )}
                  <p className="fine-print">
                    Worldwide coverage depends on participating authorities, available CAP feeds and
                    geographic matching. Regional bulletins are not automatic warnings for every
                    city in the region.{' '}
                    <a href="https://severeweather.wmo.int/" target="_blank" rel="noreferrer">
                      Open WMO's global warning map ↗
                    </a>
                  </p>
                  <p className="fine-print">
                    Notifications work only while this page is open, on supported browsers. Not an
                    emergency dispatch service.{' '}
                    {policy.polling
                      ? 'Alert feeds refresh every minute while visible.'
                      : 'Data saver pauses automatic checks and notifications. Use Refresh data for another check.'}
                    {alerts.data && <> Last checked {age(alerts.data.fetchedAt, now)}.</>}
                    {alerts.data?.partial && (
                      <> Page notifications are disabled for incomplete or regional feeds.</>
                    )}
                  </p>
                </section>
                <section className="panel hazards-panel">
                  <PanelHeader
                    eyebrow="FORECAST-BASED INDICATORS"
                    title="What deserves a closer look"
                  />
                  <p className="section-intro">
                    Transparent weather thresholds, separate from official warning levels.
                  </p>
                  {hazards.length ? (
                    <div className="hazard-list">
                      {hazards.slice(0, 4).map((h) => (
                        <div className={`hazard-item ${h.level}`} key={h.kind}>
                          <span className="hazard-symbol">
                            {h.kind === 'rain' ? (
                              <CloudRain size={18} />
                            ) : h.kind === 'wind' ? (
                              <Wind size={18} />
                            ) : h.kind === 'thunder' ? (
                              <CloudLightning size={18} />
                            ) : (
                              <Thermometer size={18} />
                            )}
                          </span>
                          <div>
                            <strong>{h.title}</strong>
                            <p>{h.detail}</p>
                            <small>
                              {localTime(h.time, tz, {
                                weekday: 'short',
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </small>
                          </div>
                          <span className="hazard-level">{h.level}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="no-hazards">
                      <Eye size={22} />
                      <p>
                        {f
                          ? 'No configured thresholds crossed in the next 24 hours, or data is stale or incomplete. This does not mean conditions are safe.'
                          : 'Fresh forecast data is needed to calculate these indicators.'}
                      </p>
                    </div>
                  )}
                  <a href="#sources" className="text-link">
                    How these signals work <ArrowUpRight size={14} />
                  </a>
                </section>
              </div>
            </>
          )}
          <OfflineBriefing
            place={place}
            forecast={f}
            alerts={alerts.data}
            now={now}
            offline={!policy.essentials}
            canSave={policy.essentials && !forecast.loading && !forecast.error && !!f && !isStale}
            onSelectPlace={selectPlace}
          />
          {policy.extras && (
            <OptionalPanel
              label="Regional reports"
              onUseEssentials={() => changeConnectionMode('lite')}
            >
              <DisasterWatch place={place} />
            </OptionalPanel>
          )}
          <section className="preparedness-banner" id="readiness">
            <div className="preparedness-art">
              <ShieldCheck size={46} />
              <span className="orbit one" />
              <span className="orbit two" />
            </div>
            <div>
              <span className="eyebrow">PREPARE BEFORE THE WARNING</span>
              <h2>A plan is more useful than a prediction.</h2>
              <p>
                Build your emergency kit, communication plan, and offline checklist. Follow local
                authorities when a warning is issued.
              </p>
            </div>
            <a className="primary-button" href="/offline.html">
              Open offline emergency kit <ArrowUpRight size={16} />
            </a>
          </section>
          <section className="panel sources-panel" id="sources">
            <PanelHeader
              eyebrow="THE EVIDENCE BEHIND THE SCREEN"
              title="Know the source. Know the limits."
            >
              <button
                className={`quiet-button ${connectionMode === 'lite' ? 'enabled' : ''}`}
                aria-pressed={connectionMode === 'lite'}
                onClick={() => changeConnectionMode(connectionMode === 'lite' ? 'full' : 'lite')}
              >
                <WifiOff size={15} />
                {connectionMode === 'lite' ? 'Data saver on' : 'Use data saver'}
              </button>
            </PanelHeader>
            <div className="sources-grid">
              <div>
                <span className="source-index">01 / FORECAST</span>
                <h3>Open-Meteo + national models</h3>
                <p>
                  Current conditions are model estimates. Hourly forecasts and two-model comparisons
                  are not direct station observations. Forecasts update as providers publish new
                  runs.
                </p>
                <a href="https://open-meteo.com/en/docs" target="_blank" rel="noreferrer">
                  Open-Meteo documentation <ArrowUpRight size={13} />
                </a>
                <small>
                  Weather data: CC BY 4.0 · {f ? `Fetched ${age(f.fetchedAt, now)}` : 'Unavailable'}
                </small>
              </div>
              <div>
                <span className="source-index">02 / SATELLITE</span>
                <h3>NASA GIBS & satellite partners</h3>
                <p>
                  Regional geostationary infrared imagery shows cloud-top temperatures. Global daily
                  imagery shows reflected sunlight. Capture times, gaps, and coverage are shown on
                  the map.
                </p>
                <a
                  href="https://www.earthdata.nasa.gov/data/tools/gibs"
                  target="_blank"
                  rel="noreferrer"
                >
                  About NASA GIBS <ArrowUpRight size={13} />
                </a>
                <small>Imagery is not a rainfall or ground-damage map.</small>
              </div>
              <div>
                <span className="source-index">03 / ALERTS & AIR</span>
                <h3>Official bulletins. Explicit coverage.</h3>
                <p>
                  Official bulletins: US NWS; direct PAGASA and BMKG CAP feeds; IMD Kolkata district
                  nowcasts; India NDMA SACHET regional feeds; and participating authorities through
                  WMO SWIC. Global coverage is incomplete. Air quality is CAMS ENSEMBLE modeled data
                  via Open-Meteo; it can miss local pollution spikes.
                </p>
                <a
                  href="https://www.weather.gov/documentation/services-web-api"
                  target="_blank"
                  rel="noreferrer"
                >
                  NWS documentation <ArrowUpRight size={13} />
                </a>
                <small>
                  AQI:{' '}
                  {air.data
                    ? `${value(air.data.usAqi)} · estimate at ${localTime(air.data.time, tz)}`
                    : 'unavailable'}
                </small>
                <ErrorNote error={air.error} />
              </div>
            </div>
            <details className="method-details">
              <summary>
                Thresholds, privacy & responsible use <ChevronDown size={16} />
              </summary>
              <div>
                <p>
                  Signals use fixed screening thresholds, not a validated impact model. Terrain,
                  drainage, buildings, vulnerability, and local warnings determine actual risk. See
                  the open-source risk module for exact thresholds. Model disagreement is not a
                  probability of danger.
                </p>
                <p>
                  City search uses GeoNames via Open-Meteo. Searches, selected coordinates, and your
                  IP address are sent to the relevant weather, imagery, geocoding, and map
                  providers. Device location is requested only when you choose it. Saved places and
                  checklist progress stay in this browser. No accounts, ads, or analytics. Interface
                  uses system fonts without font downloads. Offline briefings and emergency plans
                  stay on your device until you download or share them.{' '}
                  <button
                    className="text-button"
                    onClick={() => {
                      try {
                        localStorage.removeItem('stormsignal:places');
                        setSaved([]);
                        setToast('Saved places cleared.');
                      } catch {
                        setToast('Browser storage is unavailable.');
                      }
                    }}
                  >
                    Clear saved places
                  </button>
                  .
                </p>
                <p>
                  This noncommercial open-source edition relies on free provider quotas and has no
                  availability guarantee. Data gaps never mean safety. Use local emergency
                  authorities for decisions.
                </p>
                <a
                  href="https://github.com/TARUNTEjjjj/stormsignal/blob/main/docs/data-sources.md"
                  target="_blank"
                  rel="noreferrer"
                >
                  Read data licenses, coverage and limitations <ArrowUpRight size={13} />
                </a>
              </div>
            </details>
          </section>
          <footer className="footer">
            <a href="/offline.html" className="offline-status">
              {offlineStatus}
            </a>
            <span>
              <Radio size={16} /> stormsignal{' '}
              <small>Independent weather situational awareness</small>
            </span>
            <a href="https://github.com/TARUNTEjjjj/stormsignal" target="_blank" rel="noreferrer">
              Built in the open <Code2 size={14} />
            </a>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
          <button className="icon-button" onClick={() => setToast('')} aria-label="Dismiss message">
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
