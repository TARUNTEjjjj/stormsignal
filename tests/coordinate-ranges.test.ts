import assert from 'node:assert/strict';
import test from 'node:test';
import { readPlaces } from '../src/presentation';

test('a saved place is dropped for a coordinate off the globe alone', () => {
  const valid = {
    id: 'chennai',
    name: 'Chennai',
    country: 'India',
    countryCode: 'IN',
    latitude: 13.08,
    longitude: 80.27,
  };
  assert.deepEqual(readPlaces(JSON.stringify([valid])), [valid]);
  // Every other field stays valid, so only the range check can drop the place.
  for (const coordinates of [
    { latitude: 100 },
    { latitude: -90.0001 },
    { longitude: 181 },
    { longitude: -180.0001 },
  ]) {
    assert.deepEqual(
      readPlaces(JSON.stringify([{ ...valid, ...coordinates }, valid])),
      [valid],
      JSON.stringify(coordinates),
    );
  }
  // The poles and the antimeridian are on it.
  const edge = { ...valid, latitude: -90, longitude: 180 };
  assert.deepEqual(readPlaces(JSON.stringify([edge])), [edge]);
});
