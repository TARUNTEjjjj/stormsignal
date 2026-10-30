import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import type { GeoJsonObject } from 'geojson';
import {
  Expand,
  Layers3,
  LocateFixed,
  Minus,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Satellite,
  WifiOff,
} from 'lucide-react';
import {
  fetchImageryFrames,
  frameLabel,
  imageryForPlace,
  imageryTileUrl,
  isFrameStale,
  normalizeLongitude,
} from '../imagery';
import type { Place, WeatherAlert } from '../types';
import 'leaflet/dist/leaflet.css';
import './WeatherMap.css';

interface Props {
  place: Place;
  alerts: WeatherAlert[];
  lowBandwidth: boolean;
  onSelect: (place: Place) => void;
}
const clampLatitude = (latitude: number) => Math.max(-85, Math.min(85, latitude));

export default function WeatherMap({ place, alerts, lowBandwidth, onSelect }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.CircleMarker | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  const [ready, setReady] = useState(0);
  const [manualEnabled, setManualEnabled] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const [frames, setFrames] = useState<string[]>([]);
  const [frameSourceId, setFrameSourceId] = useState('');
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [metadataError, setMetadataError] = useState('');
  const [tileError, setTileError] = useState(false);
  const [baseError, setBaseError] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');
  const [reload, setReload] = useState(0);
  const enabled = !lowBandwidth || manualEnabled;
  const options = useMemo(
    () => imageryForPlace(place.latitude, place.longitude),
    [place.latitude, place.longitude],
  );
  const source = options.find((option) => option.id === sourceId) || options[0];
  const frame = frameSourceId === source.id ? frames[index] : undefined;

  useEffect(() => {
    setManualEnabled(false);
  }, [lowBandwidth]);
  useEffect(() => {
    setSourceId(options[0].id);
    setPlaying(false);
  }, [options]);
  useEffect(() => {
    if (!enabled || !holder.current) return;
    const instance = L.map(holder.current, {
      zoomControl: false,
      scrollWheelZoom: false,
      minZoom: 2,
      maxZoom: 11,
      worldCopyJump: true,
      attributionControl: true,
    }).setView([clampLatitude(place.latitude), place.longitude], 5);
    map.current = instance;
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      className: 'storm-basemap',
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',
    })
      .on('tileerror', () => setBaseError(true))
      .addTo(instance);
    instance.on('click', (event: L.LeafletMouseEvent) => {
      const latitude = Number(event.latlng.lat.toFixed(4));
      const longitude = Number(normalizeLongitude(event.latlng.lng).toFixed(4));
      select.current({
        id: `map:${latitude}:${longitude}`,
        name: `${Math.abs(latitude).toFixed(2)}°${latitude < 0 ? 'S' : 'N'}, ${Math.abs(longitude).toFixed(2)}°${longitude < 0 ? 'W' : 'E'}`,
        latitude,
        longitude,
        country: 'Selected map point',
        countryCode: '',
      });
    });
    const observer = new ResizeObserver(() => instance.invalidateSize());
    observer.observe(holder.current);
    setBaseError(false);
    setReady((value) => value + 1);
    return () => {
      observer.disconnect();
      instance.remove();
      map.current = null;
      marker.current = null;
    };
    // The place effect moves the existing map; changing places must not recreate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(() => {
    if (!map.current) return;
    const point: L.LatLngTuple = [
      clampLatitude(place.latitude),
      normalizeLongitude(place.longitude),
    ];
    map.current.setView(point, map.current.getZoom(), { animate: false });
    marker.current?.remove();
    marker.current = L.circleMarker(point, {
      radius: 7,
      color: '#ffffff',
      weight: 3,
      fillColor: '#56ead7',
      fillOpacity: 1,
    }).addTo(map.current);
    const name = document.createElement('span');
    name.textContent = place.name;
    marker.current
      .bindTooltip(name, { direction: 'top', className: 'storm-marker-label' })
      .openTooltip();
  }, [place.latitude, place.longitude, place.name, ready]);

  useEffect(() => {
    setFrames([]);
    setIndex(0);
    setMetadataError('');
    setPlaying(false);
    if (!enabled) return;
    const controller = new AbortController();
    setLoading(true);
    fetchImageryFrames(source, controller.signal, reload > 0)
      .then((next) => {
        if (controller.signal.aborted) return;
        setFrames(next);
        setFrameSourceId(source.id);
        // The latest daily mosaic may have incomplete swaths. It remains selectable and labelled.
        setIndex(next.length - 1);
        setLoading(false);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setMetadataError(
            error instanceof Error ? error.message : 'Satellite metadata is unavailable.',
          );
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [source.id, enabled, reload]);

  useEffect(() => {
    if (!map.current || !frame || !enabled) return;
    setTileError(false);
    setLoading(true);
    const layer = L.tileLayer(imageryTileUrl(source, frame), {
      maxNativeZoom: source.maxNativeZoom,
      maxZoom: 11,
      minZoom: 2,
      opacity: 0.86,
      updateWhenIdle: true,
      keepBuffer: 1,
      attribution: `<a href="https://www.earthdata.nasa.gov/centers/gibs" target="_blank" rel="noopener noreferrer">${source.attribution}</a>`,
    });
    layer.on('tileerror', () => setTileError(true));
    layer.on('load', () => setLoading(false));
    layer.addTo(map.current);
    // remove() fires Leaflet's internal 'remove' hook, which unregisters map
    // listeners. Calling off() first discards that hook and leaves a detached
    // GridLayer listening for view changes with _map=null.
    return () => {
      layer.remove();
    };
  }, [frame, source, ready, enabled]);

  useEffect(() => {
    if (!map.current) return;
    const group = L.layerGroup().addTo(map.current);
    for (const alert of alerts) {
      if (alert.expires <= Date.now() || !alert.geometry || typeof alert.geometry !== 'object')
        continue;
      const type = (alert.geometry as { type?: string }).type;
      if (type !== 'Polygon' && type !== 'MultiPolygon') continue;
      try {
        const shape = L.geoJSON(alert.geometry as GeoJsonObject, {
          style: {
            color: '#ff6b75',
            weight: 2,
            fillColor: '#ff5163',
            fillOpacity: 0.12,
            dashArray: '6 5',
          },
        });
        const text = document.createElement('div');
        text.textContent = `${alert.event} — ${alert.severity}. ${alert.area}`;
        shape.bindTooltip(text).addTo(group);
      } catch {
        /* A malformed provider polygon must not break the rest of the map. */
      }
    }
    return () => {
      group.remove();
    };
  }, [alerts, ready]);

  useEffect(() => {
    if (!playing || frames.length < 2 || !enabled) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setIndex((value) => (value + 1) % frames.length);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [playing, frames.length, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setReload((value) => value + 1);
    }, 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [enabled]);

  const fullscreen = async () => {
    try {
      setFullscreenError('');
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (shell.current?.requestFullscreen) await shell.current.requestFullscreen();
      else setFullscreenError('Fullscreen is unavailable in this browser.');
    } catch {
      setFullscreenError('Your browser could not enter fullscreen.');
    }
  };
  const zoom = (direction: number) => {
    direction > 0 ? map.current?.zoomIn() : map.current?.zoomOut();
  };

  return (
    <section className="storm-map-panel" aria-labelledby="satellite-heading" ref={shell}>
      <div className="storm-map-heading">
        <div>
          <span className="storm-map-eyebrow">
            <Satellite size={14} aria-hidden="true" /> EARTH OBSERVATION
          </span>
          <h2 id="satellite-heading">See the weather moving.</h2>
        </div>
        <span
          className={`storm-map-state ${frame && isFrameStale(frame, source.kind) ? 'is-stale' : ''}`}
        >
          {!enabled
            ? 'DATA SAVER'
            : frame && isFrameStale(frame, source.kind)
              ? 'DELAYED IMAGERY'
              : source.kind === 'daily'
                ? 'DAILY SATELLITE'
                : 'OBSERVED IMAGERY'}
        </span>
      </div>
      <div className="storm-map-controls">
        <div className="storm-map-layer-control">
          <Layers3 size={16} aria-hidden="true" />
          <label htmlFor="satellite-source" className="storm-visually-hidden">
            Satellite imagery layer
          </label>
          <select
            id="satellite-source"
            value={source.id}
            onChange={(event) => {
              setSourceId(event.target.value);
              setPlaying(false);
            }}
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="storm-map-button"
          aria-label="Refresh satellite availability"
          onClick={() => setReload((value) => value + 1)}
          disabled={!enabled || loading}
        >
          <RefreshCw size={16} aria-hidden="true" />
          <span>Refresh</span>
        </button>
      </div>
      <div className="storm-map-viewport">
        <div
          ref={holder}
          className="storm-map-canvas"
          role="region"
          aria-label={`Satellite map centered on ${place.name}. Use plus and minus buttons to zoom. Click a place to select it.`}
        />
        {!enabled && (
          <div className="storm-map-placeholder">
            <WifiOff size={30} aria-hidden="true" />
            <h3>Less data. The same preparedness.</h3>
            <p>
              Satellite and map downloads are paused in data saver mode. Forecasts and warning
              details remain available.
            </p>
            <button type="button" onClick={() => setManualEnabled(true)}>
              Load this map
            </button>
          </div>
        )}
        {enabled && (
          <>
            <div className="storm-map-location">
              <span className="storm-map-dot" />
              <span>{place.name}</span>
            </div>
            <div className="storm-map-tools">
              <button type="button" aria-label="Zoom in map" onClick={() => zoom(1)}>
                <Plus size={19} aria-hidden="true" />
              </button>
              <button type="button" aria-label="Zoom out map" onClick={() => zoom(-1)}>
                <Minus size={19} aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label="Center map on selected location"
                onClick={() =>
                  map.current?.setView([clampLatitude(place.latitude), place.longitude], 5)
                }
              >
                <LocateFixed size={18} aria-hidden="true" />
              </button>
              <button type="button" aria-label="Toggle map fullscreen" onClick={fullscreen}>
                <Expand size={17} aria-hidden="true" />
              </button>
            </div>
            <div className="storm-map-caption">
              {source.kind === 'infrared'
                ? 'Infrared cloud-top temperature · not rainfall radar'
                : 'Daytime surface and cloud imagery · not a live camera'}
            </div>
            {loading && (
              <span className="storm-map-loading" role="status">
                Loading satellite data…
              </span>
            )}
          </>
        )}
      </div>
      {enabled && (
        <div className="storm-map-timeline">
          <button
            type="button"
            aria-label={playing ? 'Pause satellite animation' : 'Play recent satellite frames'}
            onClick={() => setPlaying((value) => !value)}
            disabled={frames.length < 2}
          >
            {playing ? (
              <Pause size={16} aria-hidden="true" />
            ) : (
              <Play size={16} aria-hidden="true" />
            )}
          </button>
          <div className="storm-map-timeline-track">
            <div>
              <span>{source.kind === 'daily' ? 'COMPOSITE DATE' : 'OBSERVATION TIME'}</span>
              <strong>
                {frame ? frameLabel(frame, source.kind) : 'Awaiting provider timestamps'}
              </strong>
            </div>
            <label htmlFor="satellite-frame" className="storm-visually-hidden">
              Satellite frame
            </label>
            <input
              id="satellite-frame"
              type="range"
              min={0}
              max={Math.max(0, frames.length - 1)}
              value={index}
              disabled={!frames.length}
              onChange={(event) => {
                setIndex(Number(event.target.value));
                setPlaying(false);
              }}
              aria-valuetext={frame ? frameLabel(frame, source.kind) : 'No imagery'}
            />
          </div>
          <span className="storm-map-frame-count">
            {frames.length ? `${index + 1} / ${frames.length}` : '—'}
          </span>
        </div>
      )}
      <div className="storm-map-notes">
        {(metadataError || tileError || baseError || fullscreenError) && (
          <p className="storm-map-warning" role="status">
            {metadataError ||
              (tileError
                ? 'Some satellite tiles could not load. Blank areas are missing data, not clear weather.'
                : '') ||
              (baseError ? 'Some map labels could not load.' : '') ||
              fullscreenError}
          </p>
        )}
        {Math.abs(place.latitude) > 85 && (
          <p className="storm-map-warning">
            This map projection stops at 85° latitude. The exact polar location cannot be displayed.
          </p>
        )}
        <p>
          {source.cadence}. {source.resolution}. {source.coverage}
        </p>
        <p>
          {source.kind === 'daily'
            ? 'The newest day can be incomplete. Move the slider back for an earlier overpass.'
            : 'Cold cloud tops are not a direct measure of ground-level danger. Missing pixels do not mean clear skies.'}{' '}
          {source.kind === 'infrared' && (
            <a
              href="https://gibs.earthdata.nasa.gov/legends/Clean_Longwave_Infrared_Window_Band_H.svg"
              target="_blank"
              rel="noreferrer"
            >
              Temperature scale ↗
            </a>
          )}
        </p>
        <p className="storm-map-hint">
          Select any point on the map to inspect its forecast. Red outlines show supplied official
          warning polygons only; some alerts have no polygon.
        </p>
      </div>
    </section>
  );
}
