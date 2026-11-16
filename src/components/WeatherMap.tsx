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
  EMPTY_TIMELINE,
  failedTileTracker,
  frameLabel,
  imageryForPlace,
  imageryTileUrl,
  isFrameStale,
  loadTimeline,
  normalizeLongitude,
} from '../imagery';
import { alertOutline } from '../data';
import { sourceClock } from '../connectivity';
import type { Place, WeatherAlert } from '../types';
import 'leaflet/dist/leaflet.css';
import './WeatherMap.css';

interface Props {
  place: Place;
  alerts: WeatherAlert[];
  /** The warning check's clock offset (AlertResult.clockOffset); expiry is judged on its clock. */
  clockOffset: number | undefined;
  lowBandwidth: boolean;
  onSelect: (place: Place) => void;
}
const clampLatitude = (latitude: number) => Math.max(-85, Math.min(85, latitude));

export default function WeatherMap({ place, alerts, clockOffset, lowBandwidth, onSelect }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.CircleMarker | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  const [ready, setReady] = useState(0);
  const [manualEnabled, setManualEnabled] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const [timeline, setTimeline] = useState(EMPTY_TIMELINE);
  const { frames, index, playing } = timeline;
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
  const frame = timeline.sourceId === source.id ? frames[index] : undefined;

  useEffect(() => {
    setManualEnabled(false);
  }, [lowBandwidth]);
  useEffect(() => {
    setSourceId(options[0].id);
    setTimeline((current) => ({ ...current, playing: false }));
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
      // The notice clears once no failed tile remains on the map, as after panning away.
      .on(failedTileTracker(setBaseError))
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
    // A permanent label opens with the marker. A hover tooltip would give the marker focus and blur
    // listeners: Chrome then makes it an unnamed Tab stop, and tabbing past it hides the label.
    marker.current.bindTooltip(name, {
      permanent: true,
      direction: 'top',
      className: 'storm-marker-label',
    });
  }, [place.latitude, place.longitude, place.name, ready]);

  useEffect(() => {
    // A refresh of the layer on the map keeps its frames, selection and playback while it runs
    // and after it fails. Another layer, or a paused map, starts empty.
    return loadTimeline(source, enabled, reload > 0, setTimeline, (busy, error) => {
      setLoading(busy);
      setMetadataError(error);
    });
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
      attribution: `<a href="https://nasa-gibs.github.io/gibs-api-docs/access-basics/" target="_blank" rel="noopener noreferrer">${source.attribution}</a>`,
    });
    // A refresh can keep this layer for a long time; its notice follows the tiles still shown.
    layer.on(failedTileTracker(setTileError));
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
    // Leaflet does not wrap longitudes: outlines are drawn in the world copy around the marker.
    const longitude = Number.isFinite(place.longitude) ? normalizeLongitude(place.longitude) : NaN;
    const current = sourceClock(Date.now(), clockOffset);
    for (const alert of alerts) {
      if (alert.expires <= current || !alert.geometry || typeof alert.geometry !== 'object')
        continue;
      try {
        const outline = alertOutline(alert.geometry, longitude);
        if (!outline) continue;
        const shape = L.geoJSON(outline as GeoJsonObject, {
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
        // The hover tooltip makes each outline a Tab stop (focus opens it), so each needs a name.
        shape.eachLayer((layer) =>
          (layer as L.Path)
            .getElement?.()
            ?.setAttribute('aria-label', `Official warning area: ${text.textContent}`),
        );
      } catch {
        /* A malformed provider polygon must not break the rest of the map. */
      }
    }
    return () => {
      group.remove();
    };
  }, [alerts, ready, place.longitude, clockOffset]);

  useEffect(() => {
    if (!playing || frames.length < 2 || !enabled) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible')
        setTimeline((current) => ({
          ...current,
          index: (current.index + 1) % Math.max(1, current.frames.length),
        }));
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
            // View state only, so app updates never wait for it (resources/app-updates.mjs).
            data-update-safe
            value={source.id}
            onChange={(event) => {
              setSourceId(event.target.value);
              setTimeline((current) => ({ ...current, playing: false }));
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
          // Busy while frames or tiles load, not disabled: that would drop keyboard focus.
          onClick={() => {
            if (!loading) setReload((value) => value + 1);
          }}
          disabled={!enabled}
          aria-disabled={loading || undefined}
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
            onClick={() => setTimeline((current) => ({ ...current, playing: !current.playing }))}
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
              // View state only, so app updates never wait for it (resources/app-updates.mjs).
              data-update-safe
              min={0}
              max={Math.max(0, frames.length - 1)}
              value={index}
              disabled={!frames.length}
              onChange={(event) => {
                const selected = Number(event.target.value);
                setTimeline((current) => ({ ...current, index: selected, playing: false }));
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
          warning polygons only; some alerts have no polygon, or one too large to show here. An area
          that crosses 180° longitude is drawn in parts; a dashed line along 180° is where they
          join, not a warning boundary.
        </p>
      </div>
    </section>
  );
}
