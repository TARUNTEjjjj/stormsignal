import test from 'node:test';
import assert from 'node:assert/strict';
import { createKolkataAlertAdapter, supportsKolkata } from '../server/kolkata';
import type { TextOptions } from '../server/http';
import type { Place } from '../src/types';

const now = Date.now();
const place: Place = {
  id: '1275004',
  name: 'Kolkata',
  country: 'India',
  countryCode: 'IN',
  admin: 'West Bengal',
  latitude: 22.56263,
  longitude: 88.36304,
};
const ist = (time: number) => new Date(time + 330 * 60_000).toISOString().slice(0, 19) + '+5:30';
function item(options: Record<string, string> = {}) {
  const values = {
    title: 'KOLKATA',
    guid: 'fixture-1',
    sent: ist(now - 60_000),
    Onset: ist(now - 120_000),
    Expires: ist(now + 3_600_000),
    category: 'NOWCAST',
    description: 'Moderate rain: 5-15 mm/hr ,\nModerate Thunderstorms with lightning ,',
    ...options,
  };
  return `<item xmlns:dc="ns:1">${Object.entries(values)
    .map(([key, value]) => `<${key}>${value}</${key}>`)
    .join(
      '',
    )}<link>https://mausam.imd.gov.in/imd_latest/contents/districtwisewarnings.php</link><sender>nowcastnwfc@gmail.com</sender><SenderName>nowcastnwfc@gmail.com</SenderName><pubDate>Sat, 31 Oct 2026 17:36:52 </pubDate></item>`;
}
const rss = (items = item()) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>IMD WARNING </title><description>IMD RSS</description><language>en</language>${items}</channel></rss>`;
function harness(raw = rss()) {
  const calls: { url: string; options?: TextOptions }[] = [];
  const fetch = createKolkataAlertAdapter(async (url, options) => {
    calls.push({ url, options });
    return { text: raw, fetchedAt: now - 500 };
  });
  return { fetch, calls };
}

test('Kolkata support requires exact named city and state, not arbitrary points or nearby districts', () => {
  assert.equal(supportsKolkata(place), true);
  assert.equal(
    supportsKolkata({ ...place, name: ' Kolkata ', admin: 'State of West Bengal' }),
    true,
  );
  for (const changed of [
    { name: 'Kolkata North' },
    { name: 'Selected point' },
    { admin: 'Maharashtra' },
    { admin: undefined },
    { countryCode: 'US' },
    { latitude: NaN },
    { longitude: 181 },
  ])
    assert.equal(supportsKolkata({ ...place, ...changed }), false);
});

test('direct IMD RSS read is bounded, caches for one minute, and keeps explicit IST validity', async () => {
  const h = harness();
  const result = await h.fetch(place);
  assert.equal(h.calls.length, 1);
  assert.equal(
    h.calls[0].url,
    'https://mausam.imd.gov.in/imd_latest/contents/dist_nowcast_rss.php',
  );
  assert.equal(h.calls[0].options?.maxBytes, 256_000);
  assert.equal(h.calls[0].options?.ttlMs, 60_000);
  assert.equal(result.source, 'IMD Kolkata district nowcasts (direct)');
  assert.equal(result.scope, 'region');
  assert.equal(result.scopeLabel, 'Kolkata district');
  assert.equal(result.partial, true);
  assert.equal(result.fetchedAt, now - 500);
  assert.equal(result.alerts[0].sent, Math.floor((now - 60_000) / 1000) * 1000);
  assert.equal(result.alerts[0].effective, result.alerts[0].sent);
  assert.ok(
    result.alerts[0].description.includes(
      new Date(Math.floor((now - 120_000) / 1000) * 1000).toISOString(),
    ),
  );
  assert.equal(result.alerts[0].expires, Math.floor((now + 3_600_000) / 1000) * 1000);
  assert.equal(result.alerts[0].severity, 'Unknown');
  assert.equal(result.alerts[0].instruction, '');
  assert.match(result.alerts[0].description, /Moderate rain: 5-15 mm\/hr/);
  assert.equal(result.alerts[0].geometry, null);
  assert.match(result.coverage, /not an all-clear/);
});

test('actual public-feed RSS shape without Kolkata remains explicitly unmatched', async () => {
  // Fields and timezone spelling from the public Jajapur item observed 1 November 2026.
  const actualShape = `<item xmlns:dc='ns:1'><title>JAJAPUR</title><guid>a2eb9cff196c440bc37444c2aaaebb90</guid><link>https://mausam.imd.gov.in/imd_latest/contents/districtwisewarnings.php</link><sent>2026-10-31T17:36:52+5:30</sent><sender>nowcastnwfc@gmail.com</sender><pubDate>Sat, 31 Oct 2026 17:36:52 </pubDate><SenderName>nowcastnwfc@gmail.com</SenderName><Onset>2026-10-31T16:47:00+5:30</Onset><Expires>2026-10-31T19:47:00+5:30</Expires><description><![CDATA[Moderate rain: 5-15 mm/hr ,\nModerate Thunderstorms with maximum surface wind speed between 41 - 61 kmph (In gusts) ,]]></description><category>NOWCAST</category></item>`;
  const h = harness(rss(actualShape));
  const result = await h.fetch(place);
  assert.deepEqual(result.alerts, []);
  assert.equal(result.feedUpdatedAt, Date.parse('2026-10-31T17:36:52+05:30'));
  assert.equal(result.partial, true);
  assert.match(result.coverage, /No Kolkata entry was present/);
});

test('district bulletin text decodes XML numeric character references', async () => {
  const result = await harness(
    rss(item({ description: 'Moderate rain&#44; don&#39;t travel &#x2014; IMD' })),
  ).fetch(place);
  assert.equal(result.alerts.length, 1);
  assert.match(result.alerts[0].description, /Moderate rain, don't travel — IMD/);
  assert.doesNotMatch(result.alerts[0].description, /&#/);
});

test('district names match exactly and latest district publication suppresses older valid records', async () => {
  const result = await harness(
    rss(
      item({ title: 'NORTH KOLKATA', guid: 'other-district' }) +
        item({ guid: 'old-still-valid', sent: ist(now - 120_000) }) +
        item({ guid: 'new-expired', sent: ist(now - 60_000), Expires: ist(now - 10_000) }),
    ),
  ).fetch(place);
  assert.deepEqual(result.alerts, []);
  assert.equal(result.scopeLabel, 'Kolkata district');
});

test('published warnings for future weather remain visible, while explicit no-warning updates are excluded', async () => {
  const updates: Record<string, string>[] = [
    { description: 'No Warning' },
    { description: 'No Weather.' },
  ];
  for (const update of updates) {
    const result = await harness(rss(item(update))).fetch(place);
    assert.deepEqual(result.alerts, []);
  }
  const futureOnset = await harness(rss(item({ Onset: ist(now + 60_000) }))).fetch(place);
  assert.equal(futureOnset.alerts.length, 1);
  assert.equal(futureOnset.alerts[0].effective, futureOnset.alerts[0].sent);
  assert.ok(
    futureOnset.alerts[0].description.includes(
      new Date(Math.floor((now + 60_000) / 1000) * 1000).toISOString(),
    ),
  );
  const result = await harness(
    rss(item({ description: 'No warning for flood; thunderstorms expected.' })),
  ).fetch(place);
  assert.equal(result.alerts.length, 1);
});

test('missing, timezone-less, future, impossible and inverted local timestamps fail closed', async () => {
  const updates: Record<string, string>[] = [
    { Expires: '' },
    { sent: '2026-11-01T01:00:00' },
    { sent: ist(now + 600_000) },
    { Onset: '2026-02-30T01:00:00+5:30' },
    { Expires: ist(now - 600_000) },
  ];
  for (const update of updates)
    await assert.rejects(
      harness(rss(item(update))).fetch(place),
      /timestamp|time|calendar|validity|text/,
    );
});

test('empty RSS is limited availability without inferred current publication time', async () => {
  const result = await harness(rss('')).fetch(place);
  assert.deepEqual(result.alerts, []);
  assert.equal(result.feedUpdatedAt, null);
  assert.match(result.coverage, /No verifiable feed publication time/);
  assert.match(result.coverage, /No Kolkata entry/);
});

test('provider-supplied links are not followed and description markup is never returned as markup', async () => {
  const h = harness(
    rss(item({ description: '<![CDATA[Heavy rain.<br/>Follow IMD instructions.]]>' })).replace(
      'https://mausam.imd.gov.in/imd_latest/contents/districtwisewarnings.php',
      'https://evil.example/secret',
    ),
  );
  const result = await h.fetch(place);
  assert.equal(h.calls.length, 1);
  assert.equal(
    result.alerts[0].url,
    'https://mausam.imd.gov.in/kolkataums/district_nowcast_kolums.php',
  );
  assert.doesNotMatch(result.alerts[0].description, /<br/);
  assert.match(result.alerts[0].description, /Heavy rain.*Follow IMD/);
});

test('malformed XML, entity declarations, unexpected feed schema and oversized feeds fail closed', async () => {
  for (const raw of [
    '<rss><channel></rss>',
    '<!DOCTYPE rss [<!ENTITY test "unsafe">]>' + rss(),
    rss().replace('IMD WARNING ', 'Other feed'),
    rss('x'.repeat(256_000)),
    rss(item({ category: 'OTHER' })),
  ])
    await assert.rejects(harness(raw).fetch(place));
});

test('duplicate records deduplicate but conflicting latest publications fail closed', async () => {
  assert.equal((await harness(rss(item() + item())).fetch(place)).alerts.length, 1);
  await assert.rejects(
    harness(rss(item() + item({ guid: 'conflict' }))).fetch(place),
    /conflicting/,
  );
  await assert.rejects(
    harness(rss(item() + item({ description: 'Different content' }))).fetch(place),
    /conflicting/,
  );
});

test('unsupported places, provider failures and cancellation do not return an available empty list', async () => {
  const h = harness();
  await assert.rejects(h.fetch({ ...place, admin: 'Odisha' }), /Choose Kolkata/);
  assert.equal(h.calls.length, 0);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(h.fetch(place, controller.signal), /cancelled/);
  assert.equal(h.calls.length, 0);
  const failed = createKolkataAlertAdapter(async () => {
    throw new Error('provider down');
  });
  await assert.rejects(failed(place), /provider down/);
});
