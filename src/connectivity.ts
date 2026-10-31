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

export function alertCheckIsRecent(fetchedAt: number | undefined, now: number, online: boolean) {
  return (
    online &&
    typeof fetchedAt === 'number' &&
    Number.isFinite(fetchedAt) &&
    fetchedAt <= now + 60_000 &&
    now - fetchedAt <= 2 * 60_000
  );
}
