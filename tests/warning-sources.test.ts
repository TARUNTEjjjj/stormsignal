import assert from 'node:assert/strict';
import test from 'node:test';
import { localWarningSources, warningSourceFallback } from '../src/warning-sources';
import type { Place } from '../src/types';

const at = (countryCode: string, name: string, admin?: string): Place => ({
  id: name,
  name,
  country: '',
  countryCode,
  latitude: 0,
  longitude: 0,
  ...(admin === undefined ? {} : { admin }),
});

test('an Indian state with an IMD regional page lists that page first, then the other three', () => {
  const regions = [
    ['West Bengal', 'IMD Kolkata / West Bengal', 'https://mausam.imd.gov.in/kolkata/'],
    ['Maharashtra', 'IMD Mumbai / Maharashtra', 'https://mausam.imd.gov.in/mumbai/'],
    ['Odisha', 'IMD Odisha', 'https://mausam.imd.gov.in/bhubaneswar/'],
    ['Tamil Nadu', 'IMD Chennai / Tamil Nadu', 'https://mausam.imd.gov.in/chennai/'],
  ];
  for (const [admin, label, url] of regions) {
    const city = at('IN', 'City', admin);
    const sources = localWarningSources(city);
    assert.deepEqual(sources[0], { label, url }, admin);
    assert.deepEqual(
      sources.map((source) => source.url).sort(),
      regions.map(([, , page]) => page).sort(),
      admin,
    );
    assert.equal(warningSourceFallback(city), url, admin);
  }
  // Any other state, or none, links to IMD's national warnings.
  for (const admin of ['Karnataka', undefined]) {
    const city = at('IN', 'Bengaluru', admin);
    assert.deepEqual(localWarningSources(city), [
      { label: 'IMD national warnings', url: 'https://mausam.imd.gov.in/' },
    ]);
    assert.equal(warningSourceFallback(city), 'https://mausam.imd.gov.in/');
  }
});

test('Manila and Jakarta list their regional authority page before the national one', () => {
  const ncr = {
    label: 'PAGASA Metro Manila / NCR',
    url: 'https://pagasa.dost.gov.ph/regional-forecast/ncrprsd',
  };
  const pagasa = { label: 'PAGASA national warnings', url: 'https://pagasa.dost.gov.ph/' };
  assert.deepEqual(localWarningSources(at('PH', 'Manila')), [ncr, pagasa]);
  assert.deepEqual(localWarningSources(at('PH', 'Quezon City', 'National Capital Region')), [
    ncr,
    pagasa,
  ]);
  assert.deepEqual(localWarningSources(at('PH', 'Cebu City', 'Central Visayas')), [pagasa]);
  assert.equal(warningSourceFallback(at('PH', 'Manila')), ncr.url);
  assert.equal(warningSourceFallback(at('PH', 'Cebu City', 'Central Visayas')), pagasa.url);
  const jabodetabek = {
    label: 'BMKG Jakarta / Jabodetabek',
    url: 'https://www.bmkg.go.id/peringatan-dini/curah-hujan/nowcasting/31',
  };
  const bmkg = { label: 'BMKG national warnings', url: 'https://www.bmkg.go.id/peringatan-dini' };
  assert.deepEqual(localWarningSources(at('ID', 'Jakarta')), [jabodetabek, bmkg]);
  assert.deepEqual(
    localWarningSources(at('ID', 'Central Jakarta', 'Jakarta Special Capital Region')),
    [jabodetabek, bmkg],
  );
  assert.deepEqual(localWarningSources(at('ID', 'Surabaya', 'East Java')), [bmkg]);
  assert.equal(warningSourceFallback(at('ID', 'Jakarta')), jabodetabek.url);
  assert.equal(warningSourceFallback(at('ID', 'Surabaya', 'East Java')), bmkg.url);
});

test('U.S. places and territories fall back to weather.gov, other countries to WMO', () => {
  const sanFrancisco = at('US', 'San Francisco', 'California');
  assert.deepEqual(localWarningSources(sanFrancisco), [
    { label: 'NWS San Francisco Bay Area', url: 'https://www.weather.gov/mtr/' },
  ]);
  assert.equal(warningSourceFallback(sanFrancisco), 'https://www.weather.gov/mtr/');
  for (const code of ['US', 'PR', 'VI', 'GU', 'AS', 'MP']) {
    const elsewhere = at(code, 'Elsewhere');
    assert.deepEqual(localWarningSources(elsewhere), [], code);
    assert.equal(warningSourceFallback(elsewhere), 'https://www.weather.gov/', code);
  }
  for (const code of ['FR', 'JP', 'BR', '']) {
    const elsewhere = at(code, 'Elsewhere');
    assert.deepEqual(localWarningSources(elsewhere), [], code);
    assert.equal(warningSourceFallback(elsewhere), 'https://severeweather.wmo.int/', code);
  }
});
