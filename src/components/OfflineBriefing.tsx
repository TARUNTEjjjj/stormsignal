import { useEffect, useState } from 'react';
import { Download, FileText, Save, Trash2, TriangleAlert } from 'lucide-react';
import { age, localTime, value } from '../presentation';
import type { AlertResult, Forecast, Place } from '../types';
import {
  OFFLINE_PACK_KEY,
  MAX_BRIEFINGS,
  briefingId,
  briefingText,
  clearBriefings,
  createBriefing,
  loadBriefings,
  removeBriefing,
  saveBriefing,
  type BriefingResult,
  type OfflineBriefingData,
} from '../offline';
import './OfflineBriefing.css';

interface Props {
  place: Place;
  forecast: Forecast | null;
  alerts: AlertResult | null;
  now: number;
  offline: boolean;
  canSave?: boolean;
  onSelectPlace?: (place: Place) => void;
}
const stamp = (time: number) =>
  localTime(time, 'UTC', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }) + ' UTC';

export default function OfflineBriefing({
  place,
  forecast,
  alerts,
  now,
  offline,
  canSave = false,
  onSelectPlace,
}: Props) {
  const [saved, setSaved] = useState<BriefingResult>({ briefings: [], error: null });
  const [selectedId, setSelectedId] = useState('');
  const [message, setMessage] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const refresh = () => {
    try {
      setSaved(loadBriefings(window.localStorage));
    } catch {
      setSaved({
        briefings: [],
        error: 'Browser storage is blocked. Saved briefings are unavailable.',
      });
    }
  };
  useEffect(() => {
    refresh();
    const sync = (event: StorageEvent) => {
      if (event.key === OFFLINE_PACK_KEY || event.key === null) refresh();
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  useEffect(() => {
    const matching = saved.briefings.find((item) => item.id === briefingId(place));
    setSelectedId(matching?.id || saved.briefings[0]?.id || '');
  }, [place.latitude, place.longitude, saved.briefings]);
  const selected = saved.briefings.find((item) => item.id === selectedId) || saved.briefings[0];
  const fresh =
    !!forecast && now - forecast.fetchedAt <= 3_600_000 && forecast.fetchedAt <= now + 300_000;
  const currentAvailable = canSave && !offline && fresh;
  const saveAllowed = currentAvailable && !saved.error;
  const storeCurrent = () => {
    if (!saveAllowed || !forecast) return;
    try {
      const briefing = createBriefing(place, forecast, alerts, Date.now());
      const result = saveBriefing(window.localStorage, briefing);
      if (!result.error) setSaved(result);
      setMessage(
        result.error ||
          `${place.name} briefing saved on this device. Up to ${MAX_BRIEFINGS} places are retained; the oldest is replaced when full.`,
      );
    } catch {
      setMessage(
        'The briefing could not be saved. Refresh the forecast and try again; browser storage may also be unavailable.',
      );
    }
  };
  const remove = (item: OfflineBriefingData) => {
    try {
      const result = removeBriefing(window.localStorage, item.id);
      if (!result.error) setSaved(result);
      setMessage(result.error || `Saved briefing for ${item.place.name} removed.`);
    } catch {
      setMessage('Browser storage could not be updated.');
    }
  };
  const download = (item: OfflineBriefingData) => {
    try {
      const blob = new Blob([briefingText(item)], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `stormsignal-briefing-${new Date(item.savedAt).toISOString().slice(0, 10)}.txt`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage('Text briefing download requested. Keep it with your offline emergency kit.');
    } catch {
      setMessage(
        'The text download could not be created. Browser storage or downloads may be restricted.',
      );
    }
  };
  const reset = () => {
    try {
      const result = clearBriefings(window.localStorage);
      if (!result.error) setSaved(result);
      setMessage(result.error || 'Saved briefings cleared. Other StormSignal data was kept.');
    } catch {
      setMessage('Browser storage could not be cleared.');
    }
    setConfirmClear(false);
  };
  const downloadCurrent = () => {
    if (!currentAvailable || !forecast) return;
    try {
      download(createBriefing(place, forecast, alerts, Date.now()));
    } catch {
      setMessage(
        'A fresh briefing could not be created. Refresh the forecast before trying again.',
      );
    }
  };
  return (
    <section
      className="panel offline-briefing"
      id="offline-briefings"
      aria-labelledby="briefing-title"
    >
      <div className="panel-heading">
        <div>
          <span className="eyebrow">SAVE BEFORE THE SIGNAL GOES</span>
          <h2 id="briefing-title">Your offline briefing.</h2>
        </div>
        <FileText size={25} aria-hidden="true" />
      </div>
      <p className="briefing-intro">
        Keep the last retrieved forecast and warning text for up to three places. Saves are on this
        device only. An offline briefing cannot receive new warnings or confirm current conditions.
      </p>
      <div className="briefing-actions">
        <button
          className="primary-button"
          type="button"
          onClick={storeCurrent}
          disabled={!saveAllowed}
        >
          <Save size={16} aria-hidden="true" /> Save {place.name} briefing
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={downloadCurrent}
          disabled={!currentAvailable}
        >
          <Download size={16} aria-hidden="true" /> Download current briefing
        </button>
        <a className="secondary-button" href="/offline.html">
          Open offline emergency kit ↗
        </a>
      </div>
      {!saveAllowed && (
        <p className="briefing-help">
          {offline
            ? 'Connect and refresh weather to save a new briefing. Saved copies below remain readable.'
            : saved.error
              ? 'Saved-data storage needs attention. A fresh briefing can still be downloaded directly.'
              : 'A recent forecast must finish loading before a briefing can be saved.'}
        </p>
      )}
      <p className="briefing-help">
        The save button stores the selected place and its coordinates. Saving a fourth place
        replaces the oldest saved briefing. Download a text copy to keep it separately.
      </p>
      <p role="status" className="briefing-message">
        {message}
      </p>
      {saved.error && (
        <div className="briefing-warning" role="status">
          <TriangleAlert size={17} aria-hidden="true" />
          <span>{saved.error}</span>
        </div>
      )}
      {saved.error && (
        <div className="briefing-actions">
          {!confirmClear ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => setConfirmClear(true)}
            >
              Clear unreadable saved briefings
            </button>
          ) : (
            <>
              <p>This clears only saved briefings from this browser. Downloaded copies remain.</p>
              <button type="button" className="secondary-button" onClick={reset}>
                Confirm clear briefings
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setConfirmClear(false)}
              >
                Keep saved data
              </button>
            </>
          )}
        </div>
      )}
      {!saved.error && !selected && (
        <div className="briefing-empty">
          <FileText size={24} aria-hidden="true" />
          <h3>No briefing saved yet.</h3>
          <p>
            Save a briefing while connected. The offline emergency kit works without weather data
            once opened or downloaded in advance.
          </p>
        </div>
      )}
      {selected && (
        <>
          <label className="briefing-select-label" htmlFor="saved-briefing">
            Read a saved place
          </label>
          <select
            id="saved-briefing"
            value={selected.id}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {saved.briefings.map((item) => (
              <option key={item.id} value={item.id}>
                {item.place.name} · saved {stamp(item.savedAt)}
              </option>
            ))}
          </select>
          <article className="briefing-copy">
            <div className="briefing-warning">
              <TriangleAlert size={18} aria-hidden="true" />
              <div>
                <strong>SAVED COPY · CURRENT STATUS UNKNOWN</strong>
                <p>
                  {age(selected.savedAt, now)} · saved {stamp(selected.savedAt)}. Conditions and
                  warnings may have changed or been cancelled.{' '}
                  {now - selected.savedAt > 24 * 3_600_000
                    ? 'This briefing is over a day old and is for historical reference only.'
                    : 'Do not use this as an all-clear.'}
                </p>
              </div>
            </div>
            <h3>
              {selected.place.name}, {selected.place.country || 'selected coordinates'}
            </h3>
            <p className="briefing-help">
              {selected.place.latitude.toFixed(4)}, {selected.place.longitude.toFixed(4)} ·{' '}
              {selected.forecast.timezone}
            </p>
            <dl className="briefing-facts">
              <div>
                <dt>Forecast retrieved</dt>
                <dd>{stamp(selected.forecast.fetchedAt)}</dd>
              </div>
              <div>
                <dt>Model time</dt>
                <dd>{stamp(selected.forecast.current.time)}</dd>
              </div>
              <div>
                <dt>Saved temperature</dt>
                <dd>
                  {value(selected.forecast.current.temperature)} °C · feels like{' '}
                  {value(selected.forecast.current.apparent)} °C
                </dd>
              </div>
            </dl>
            <details className="briefing-hours">
              <summary>
                Read the saved hourly forecast ({selected.forecast.hours.length} points)
              </summary>
              <p>
                These are model estimates saved earlier, not new observations. Each rain value is
                for one hour; missing values are shown as —.
              </p>
              <div
                className="briefing-table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Saved hourly forecast table"
              >
                <table>
                  <caption>
                    {selected.forecast.source} · local times in {selected.forecast.timezone}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Time</th>
                      <th scope="col">°C</th>
                      <th scope="col">Feels °C</th>
                      <th scope="col">Rain mm</th>
                      <th scope="col">Chance %</th>
                      <th scope="col">Gust km/h</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.forecast.hours.map((hour) => (
                      <tr key={hour.time}>
                        <th scope="row">
                          {localTime(hour.time, selected.forecast.timezone, {
                            day: '2-digit',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </th>
                        <td>{value(hour.temperature)}</td>
                        <td>{value(hour.apparent)}</td>
                        <td>{value(hour.precipitation, 1)}</td>
                        <td>{value(hour.probability)}</td>
                        <td>{value(hour.gust)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
            <div className="briefing-warnings">
              <h4>Warning text saved at that time</h4>
              <p>{selected.warnings.coverage}</p>
              {selected.warnings.scopeLabel && (
                <p>
                  Saved coverage: {selected.warnings.scopeLabel} ({selected.warnings.scope}).
                </p>
              )}
              {selected.warnings.partial && (
                <p className="briefing-warning">
                  This saved feed had incomplete coverage. Regional bulletins do not apply to every
                  place in the region.
                </p>
              )}
              {selected.warnings.feedUpdatedAt && (
                <p>
                  Latest feed bulletin when saved: {stamp(selected.warnings.feedUpdatedAt)}. This is
                  not a new check.
                </p>
              )}
              <p>
                {selected.warnings.fetchedAt === null
                  ? 'The warning feed was not verified when saved.'
                  : `Feed retrieved ${stamp(selected.warnings.fetchedAt)}. This is not a new check.`}
              </p>
              {!selected.warnings.alerts.length && (
                <p className="briefing-warning">
                  No warning text was saved. Missing or unsupported warnings do not mean no danger.
                </p>
              )}
              {selected.warnings.alerts.map((alert) => (
                <details key={alert.id} className="briefing-alert">
                  <summary>
                    {alert.event} · {alert.severity} ·{' '}
                    {alert.expires <= now ? 'Past stated expiry' : 'Saved; not verified now'}
                  </summary>
                  <h5>{alert.title}</h5>
                  <p>{alert.area}</p>
                  <p>
                    Issued {stamp(alert.sent)} · effective {stamp(alert.effective)} · stated expiry{' '}
                    {stamp(alert.expires)}
                  </p>
                  <p className="briefing-verbatim">{alert.description}</p>
                  <strong>Instructions as saved</strong>
                  <p className="briefing-verbatim">
                    {alert.instruction || 'No instructions were supplied in this warning.'}
                  </p>
                  <a href={alert.url} target="_blank" rel="noreferrer">
                    Original {alert.source} warning (internet required) ↗
                  </a>
                </details>
              ))}
              {selected.warnings.omitted > 0 && (
                <p className="briefing-warning">
                  {selected.warnings.omitted} additional warning(s) were not included. This is a
                  limited snapshot.
                </p>
              )}
              <a href={selected.warnings.officialUrl} target="_blank" rel="noreferrer">
                Check the official weather authority (internet required) ↗
              </a>
            </div>
            <div className="briefing-actions">
              <button type="button" className="secondary-button" onClick={() => download(selected)}>
                <Download size={16} aria-hidden="true" /> Download text briefing
              </button>
              {onSelectPlace && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => onSelectPlace(selected.place)}
                >
                  Select this place
                </button>
              )}
              <button type="button" className="briefing-remove" onClick={() => remove(selected)}>
                <Trash2 size={15} aria-hidden="true" /> Remove saved briefing
              </button>
            </div>
          </article>
        </>
      )}
    </section>
  );
}
