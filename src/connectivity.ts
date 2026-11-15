import type { AlertResult, WeatherAlert } from './types';

export type ConnectionMode = 'lite' | 'full' | 'offline';
export const CONNECTION_KEY = 'stormsignal:connection-mode';

export function readConnectionMode(value: string | null): ConnectionMode {
  return value === 'full' || value === 'offline' ? value : 'lite';
}

/** Fail closed when offline. The browser's online signal is not proof of reachability. */
export function networkPolicy(mode: ConnectionMode, online: boolean) {
  const essentials = online && (mode === 'lite' || mode === 'full');
  return {
    essentials,
    extras: essentials && mode === 'full',
    polling: essentials && mode === 'full',
  };
}

/**
 * Start the dashboard clock: `tick` receives the time at once and then every `period`, and `poll`
 * runs on each periodic tick. A restart (the clock restarts on every connection-mode change) reports
 * the time immediately, so a check that completes before the next periodic tick is never judged
 * against a reading from before the restart. Returns the function that stops the clock.
 */
export function startClock(
  tick: (now: number) => void,
  poll: () => void,
  period = 60_000,
): () => void {
  tick(Date.now());
  const timer = setInterval(() => {
    tick(Date.now());
    poll();
  }, period);
  return () => clearInterval(timer);
}

export function alertCheckIsRecent(fetchedAt: number | undefined, now: number, online: boolean) {
  return (
    online &&
    typeof fetchedAt === 'number' &&
    Number.isFinite(fetchedAt) &&
    fetchedAt <= now + 60_000 &&
    now - fetchedAt <= 2 * 60_000
  );
}

/**
 * A reading of this device's clock moved onto the clock of the source that answered a warning
 * check. `clockOffset` is the device clock minus the source's, measured when the check arrived
 * (AlertResult.clockOffset); without one the two clocks are taken to agree.
 */
export function sourceClock(now: number, clockOffset?: number): number {
  return typeof clockOffset === 'number' && Number.isFinite(clockOffset) ? now - clockOffset : now;
}

/**
 * The warnings of a check that have not passed their stated expiry at `now` on this device's clock.
 * An expiry is an instant on the source's clock, so it is compared on that clock: a device clock
 * running fast never drops a warning that is still valid, and one running slow never keeps a
 * warning that has expired.
 */
export function unexpiredAlerts(
  check: Pick<AlertResult, 'alerts' | 'clockOffset'> | null | undefined,
  now: number,
): WeatherAlert[] {
  if (!check) return [];
  const current = sourceClock(now, check.clockOffset);
  return check.alerts.filter((alert) => alert.expires > current);
}
