import type { Place } from './types';

/** Warning providers also use the city's name and administrative region. */
export function placeResourceKey(place: Place): string {
  return JSON.stringify([place.latitude, place.longitude, place.countryCode,
    place.name, place.admin ?? '', place.timezone ?? '']);
}

export function nextSearchIndex(current: number, count: number, key: string): number {
  if (count < 1) return -1;
  if (key === 'ArrowDown') return current < 0 ? 0 : (current + 1) % count;
  if (key === 'ArrowUp') return current <= 0 ? count - 1 : current - 1;
  return current;
}
