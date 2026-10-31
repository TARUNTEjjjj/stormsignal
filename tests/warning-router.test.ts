import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alertPlace, handleAlerts } from '../server/router';
test('warning route validates location inputs without making upstream requests', async () => {
  for (const query of [
    '',
    'lat=&lon=0',
    'lat=NaN&lon=0',
    'lat=91&lon=0',
    'lat=0&lon=-181',
    'lat=0&lon=0&country=XXX',
    'lat=0&lon=0&url=https://evil.example',
    'lat=0&lat=1&lon=0',
    `lat=0&lon=0&admin=${'x'.repeat(101)}`,
  ]) {
    const result = await handleAlerts(
      new Request(`https://stormsignal.invalid/api/alerts?${query}`),
    );
    assert.equal(result.status, 400, query);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
  }
});
test('warning route allows only reads and preserves bounded region metadata', async () => {
  assert.equal(
    (await handleAlerts(new Request('https://stormsignal.invalid/api/alerts', { method: 'POST' })))
      .status,
    405,
  );
  const place = alertPlace(
    new URL(
      'https://stormsignal.invalid/api/alerts?lat=20.2724&lon=85.8339&country=IN&admin=Odisha&name=Bhubaneswar',
    ),
  );
  assert.equal(place.admin, 'Odisha');
  assert.equal(place.latitude, 20.2724);
});
