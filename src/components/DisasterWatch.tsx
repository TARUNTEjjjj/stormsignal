import { useEffect, useState } from 'react';
import { ArrowUpRight, Flame, Globe2, RefreshCw, TriangleAlert, Waves, Wind } from 'lucide-react';
import {
  fetchDisasters,
  nearbyDisasters,
  GDACS_RECENT_DAYS,
  GDACS_SOURCE,
  GDACS_STALE_MS,
  type DisasterFeed,
} from '../disasters';
import type { Place } from '../types';
import './DisasterWatch.css';

const utc = (time: number) =>
  new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(time) + ' UTC';
export default function DisasterWatch({ place }: { place: Place }) {
  const [radius, setRadius] = useState(1000);
  const [feed, setFeed] = useState<DisasterFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError('');
    fetchDisasters(controller.signal, revision > 0)
      .then((result) => {
        if (active) setFeed(result);
      })
      .catch((e) => {
        if (active && !controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Regional reports are unavailable.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [revision]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    const refresh = setInterval(() => {
      if (navigator.onLine && document.visibilityState === 'visible') setRevision((r) => r + 1);
    }, 10 * 60_000);
    const resume = () => {
      setNow(Date.now());
      if (document.visibilityState === 'visible' && navigator.onLine) setRevision((r) => r + 1);
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    return () => {
      clearInterval(timer);
      clearInterval(refresh);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
    };
  }, []);
  const reports = feed ? nearbyDisasters(feed.events, place, radius, now) : [];
  const stale = feed !== null && now - feed.fetchedAt > GDACS_STALE_MS;
  return (
    <section className="panel disaster-watch" id="regional-reports" aria-busy={loading}>
      <div className="panel-heading">
        <div>
          <span className="eyebrow">GLOBAL CONTEXT · SEPARATE FROM LOCAL WARNINGS</span>
          <h2>Regional disaster reports · GDACS</h2>
        </div>
        <Globe2 className="disaster-globe" size={24} />
      </div>
      <p className="disaster-intro">
        Recent cyclone, flood, and wildfire reports around {place.name}. These show GDACS
        humanitarian-impact assessments, <strong>not official local weather warnings</strong>.
      </p>
      <div className="disaster-controls">
        <div className="segmented" role="group" aria-label="Disaster report search distance">
          {[250, 1000, 5000].map((km) => (
            <button
              type="button"
              key={km}
              className={radius === km ? 'selected' : ''}
              aria-pressed={radius === km}
              onClick={() => setRadius(km)}
            >
              {km.toLocaleString('en-GB')} km
            </button>
          ))}
        </div>
        <button
          type="button"
          className="quiet-button"
          onClick={() => setRevision((r) => r + 1)}
          disabled={loading}
        >
          <RefreshCw size={14} className={loading ? 'spin' : ''} />
          {loading ? 'Loading reports' : 'Refresh reports'}
        </button>
      </div>
      <p className="disaster-distance-note">
        Distance is to an event’s representative point. It is not the affected area, a warning
        boundary, or a measure of your safety.
      </p>
      {(error || stale) && (
        <p className="disaster-warning" role="status">
          <TriangleAlert size={15} />
          <span>
            {error ||
              'This report snapshot is over 30 minutes old. Refresh it or check GDACS directly.'}
            {error && feed ? ' Previously fetched reports remain below; they may be outdated.' : ''}
          </span>
        </p>
      )}
      {!feed && !error && (
        <p className="disaster-empty" role="status">
          Retrieving recent reports from GDACS…
        </p>
      )}
      {feed && reports.length === 0 && (
        <p className="disaster-empty">
          No matching reports in the retrieved {GDACS_RECENT_DAYS}-day snapshot within{' '}
          {radius.toLocaleString('en-GB')} km. Coverage is incomplete; absence of a report never
          means conditions are safe.
        </p>
      )}
      {reports.length > 0 && (
        <div className="disaster-cards">
          {reports.slice(0, 4).map((event) => {
            const Icon = event.kind === 'TC' ? Wind : event.kind === 'FL' ? Waves : Flame;
            return (
              <article className="disaster-card" key={event.id}>
                <div className="disaster-card-top">
                  <Icon size={18} />
                  <span className={`disaster-impact impact-${event.impact.toLowerCase()}`}>
                    {event.impact} overall GDACS impact
                  </span>
                </div>
                <h3>{event.title}</h3>
                <p className="disaster-country">
                  {event.country || 'Country not supplied'} · about{' '}
                  {Math.round(event.distanceKm).toLocaleString('en-GB')} km from report point
                </p>
                <dl>
                  <div>
                    <dt>Report period</dt>
                    <dd>
                      {utc(event.startsAt)} → {utc(event.endsAt)}
                    </dd>
                  </div>
                  <div>
                    <dt>Report updated</dt>
                    <dd>
                      {event.updatedAt !== null ? utc(event.updatedAt) : 'Update time not supplied'}
                    </dd>
                  </div>
                  <div>
                    <dt>Period status</dt>
                    <dd>
                      {event.provisional ? 'Provisional · ' : ''}
                      {event.startsAt > now
                        ? 'Report period has not started'
                        : event.endsAt < now
                          ? 'Report period ended; impacts may continue'
                          : 'Within reported period; verify current conditions'}
                    </dd>
                  </div>
                </dl>
                <div className="disaster-card-footer">
                  <small>GDACS · {event.source}</small>
                  <a href={event.reportUrl} target="_blank" rel="noreferrer">
                    Official report <ArrowUpRight size={13} />
                  </a>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {feed && (
        <p className="disaster-snapshot">
          Fetched {utc(feed.fetchedAt)} · {feed.recordsRead} global records retrieved
          {reports.length > 4 ? ` · Showing 4 of ${reports.length} nearby reports` : ''}.
          {feed.truncated
            ? ' Retrieval is capped at 200 records; additional reports may be omitted.'
            : ''}
          {feed.partial
            ? ' Additional reports could not be retrieved; this is a partial snapshot.'
            : ''}
        </p>
      )}
      <div className="disaster-footer">
        <p>
          Red, orange, and green describe GDACS’s overall potential humanitarian impact. Green does
          not mean safe at your location. Source: Global Disaster Alert and Coordination System,
          GDACS.
        </p>
        <a href={GDACS_SOURCE} target="_blank" rel="noreferrer">
          Explore GDACS <ArrowUpRight size={14} />
        </a>
      </div>
    </section>
  );
}
