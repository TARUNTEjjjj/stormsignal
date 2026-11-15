import test from 'node:test';
import assert from 'node:assert/strict';
import { createKolkataAlertAdapter, supportsKolkata } from '../server/kolkata';
import { createLocalAlertAdapter } from '../server/local-alerts';
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
/** Field order, namespace, CDATA and timezone spelling of the public item observed 1 November 2026. */
function observed(
  district: string,
  index: number,
  options: { sent?: number; description?: string } = {},
) {
  return `<item xmlns:dc='ns:1'><title>${district}</title><guid>${index.toString(16).padStart(32, '0')}</guid><link>https://mausam.imd.gov.in/imd_latest/contents/districtwisewarnings.php</link><sent>${ist(options.sent ?? now - 60_000)}</sent><sender>nowcastnwfc@gmail.com</sender><pubDate>Sat, 31 Oct 2026 17:36:52 </pubDate><SenderName>nowcastnwfc@gmail.com</SenderName><Onset>${ist(now - 120_000)}</Onset><Expires>${ist(now + 3_600_000)}</Expires><description><![CDATA[${options.description ?? 'Moderate rain: 5-15 mm/hr ,\nModerate Thunderstorms with maximum surface wind speed between 41 - 61 kmph (In gusts) ,'}]]></description><category>NOWCAST</category></item>`;
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
  assert.equal(h.calls[0].options?.maxBytes, 1_000_000);
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

test('every retrieved entry is checked: a late Kolkata entry is found and sets the feed time', async () => {
  // A busy day's national list: 249 other districts (the first 200 issued 26 hours ago), Kolkata last.
  const others = Array.from({ length: 249 }, (_, i) =>
    observed(`DISTRICT ${i + 1}`, i + 1, { sent: i < 200 ? now - 26 * 3_600_000 : now - 60_000 }),
  );
  const raw = rss(others.join('') + observed('KOLKATA', 250));
  assert.ok(Buffer.byteLength(raw) < 256_000, 'well inside the byte bound');
  const result = await harness(raw).fetch(place);
  assert.deepEqual(
    result.alerts.map((alert) => alert.id),
    [`imd-kolkata:${(250).toString(16).padStart(32, '0')}`],
  );
  assert.equal(result.feedUpdatedAt, Math.floor((now - 60_000) / 1000) * 1000);
  assert.doesNotMatch(result.coverage, /No Kolkata entry|not checked|over 24 hours old/);
});

test('a damaged entry that names no district is disclosed and does not hide the Kolkata bulletin', async () => {
  // A long national list with Kolkata first and damaged, unrelated entries far down the list.
  const others = Array.from({ length: 300 }, (_, i) => observed(`DISTRICT ${i + 1}`, i + 2));
  const feed = (...damaged: string[]) =>
    rss(observed('KOLKATA', 1) + others.join('') + damaged.join(''));
  const untitled = observed('X', 900).replace('<title>X</title>', '');
  const damaged = [
    '<item/>',
    '<item>not an entry</item>',
    untitled,
    observed(' ', 901),
    observed('A', 902).replace('<title>A</title>', '<title>A</title><title>B</title>'),
  ];
  const result = await harness(feed(...damaged)).fetch(place);
  assert.deepEqual(
    result.alerts.map((alert) => alert.id),
    [`imd-kolkata:${(1).toString(16).padStart(32, '0')}`],
  );
  assert.match(
    result.coverage,
    /5 feed entries name no district and could not be checked; a newer Kolkata bulletin may be missing\./,
  );
  const one = await harness(feed(untitled)).fetch(place);
  assert.equal(one.alerts.length, 1);
  assert.match(one.coverage, /1 feed entry names no district and could not be checked/);
  // A district name of any length is still a name: the entry is another district's.
  const long = await harness(feed(observed('D'.repeat(300), 903))).fetch(place);
  assert.equal(long.alerts.length, 1);
  assert.doesNotMatch(long.coverage, /no district/);
  assert.doesNotMatch((await harness(feed()).fetch(place)).coverage, /no district/);
  // An unnamed entry that mentions Kolkata may be Kolkata's own: the source still fails closed.
  for (const suspect of [
    '<item>KOLKATA</item>',
    observed('A', 904).replace('<title>A</title>', '<title>A</title><title>Kolkata</title>'),
    untitled.replace('Moderate rain', 'Kolkata: moderate rain'),
  ])
    await assert.rejects(harness(feed(suspect)).fetch(place), /unreadable Kolkata entry/);
  // Without a Kolkata bulletin, an unnamed entry cannot be told from Kolkata's: no empty result.
  await assert.rejects(
    harness(rss(others.join('') + untitled)).fetch(place),
    /name no district; Kolkata cannot be checked/,
  );
  // A damaged entry that is named Kolkata fails closed as before.
  await assert.rejects(
    harness(feed(observed('KOLKATA', 905).replace(/<Expires>[^<]*<\/Expires>/, ''))).fetch(place),
  );
});

test('a national feed of realistic entries up to the entry limit is read, not rejected for size', async () => {
  // About 640 bytes per entry; the former 256,000-byte bound rejected anything over ~400 districts.
  const severe =
    'Moderate rain: 5-15 mm/hr ,\nSevere Thunderstorms with maximum surface wind speed between 62 - 87 kmph (In gusts) ,\nHail ,';
  const entries = (count: number) =>
    observed('KOLKATA', 1, { description: severe }) +
    Array.from({ length: count - 1 }, (_, i) =>
      observed(`DISTRICT ${i + 2}`, i + 2, { description: severe }),
    ).join('');
  const raw = rss(entries(1000));
  const bytes = Buffer.byteLength(raw);
  assert.ok(bytes > 600_000, `fixture has ${bytes} bytes`);
  const h = harness(raw);
  const result = await h.fetch(place);
  assert.ok(bytes <= h.calls[0].options!.maxBytes!, 'the provider read accepts the whole feed');
  assert.equal(result.alerts.length, 1);
  assert.match(result.alerts[0].description, /62 - 87 kmph \(In gusts\)/);
  await assert.rejects(harness(rss(entries(1001))).fetch(place), /too many entries/);
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

test('an issue stamped slightly ahead of the server clock is current, not dropped with the one it replaced', async () => {
  const feed = rss(
    item({ guid: 'older', sent: ist(now - 2 * 3_600_000) }) +
      item({ guid: 'newer', sent: ist(now + 30_000), Expires: ist(now + 3 * 3_600_000) }),
  );
  const direct = await harness(feed).fetch(place);
  assert.deepEqual(
    direct.alerts.map((alert) => alert.id),
    ['imd-kolkata:newer'],
  );
  assert.equal(direct.alerts[0].sent, Math.floor((now + 30_000) / 1000) * 1000);
  assert.ok(direct.alerts[0].effective <= Date.now());
  // The combined Kolkata check keeps it as well.
  const unused = async (): Promise<never> => {
    throw new Error('Not used for Kolkata.');
  };
  const combined = await createLocalAlertAdapter({
    national: unused,
    global: unused,
    kolkata: harness(feed).fetch,
    india: async () => ({
      status: 'available',
      alerts: [],
      fetchedAt: now - 500,
      source: 'NDMA SACHET',
      officialUrl: 'https://sachet.ndma.gov.in/',
      scope: 'region',
      scopeLabel: 'West Bengal',
      partial: true,
      coverage: 'Limited regional feed.',
    }),
  })(place);
  assert.deepEqual(
    combined.alerts.map((alert) => alert.id),
    ['imd-kolkata:newer'],
  );
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

test('comparison signs in hazard bands are official text, never stripped as markup', async () => {
  const text = (result: { alerts: { description: string }[] }) =>
    result.alerts[0].description.split('\n\nSource weather onset:')[0];
  const bands =
    'Light rain: <5 mm/hr ,\nSevere Thunderstorms with maximum surface wind speed >87 kmph (In gusts) ,\nHail ,';
  const spaced =
    'Light rain: < 5 mm/hr ,\nVery Severe Thunderstorms with maximum surface wind speed > 87 kmph ,';
  for (const [description, expected] of [
    [`<![CDATA[${bands}]]>`, bands],
    [bands.replace('<', '&lt;').replace('>', '&gt;'), bands],
    [bands.replace('<', '&#60;').replace('>', '&#62;'), bands],
    [`<![CDATA[${spaced}]]>`, spaced],
  ])
    assert.equal(text(await harness(rss(item({ description }))).fetch(place)), expected);
  const mixed = await harness(
    rss(
      item({
        description:
          '<![CDATA[Heavy rain <br/>wind >87 kmph, rain <5 mm/hr<p class="x">Hail</p>]]>',
      }),
    ),
  ).fetch(place);
  assert.equal(text(mixed), 'Heavy rain wind >87 kmph, rain <5 mm/hr Hail');
  // A "<" directly before a letter is official text too, unless it opens a formatting tag or link.
  for (const official of [
    'Rainfall <a few mm, gusts >40 kmph',
    'Visibility <one km; wind speed >40 kmph',
    'Thunderstorm <T> with hail',
    'Temperature <normal (departure = -2), humidity >90%',
    'Gusts <big hail likely> expected',
    // A formatting tag's name followed by words, not by name=value attributes, is text as well.
    'Winds <strong at times, gusts >40 kmph',
    'Hail <small to medium size>, gusts >40 kmph',
    'Category <B (minor), gusts >40 kmph',
    'Wind <u 40 kmph> gusts',
  ])
    assert.equal(
      text(await harness(rss(item({ description: `<![CDATA[${official}]]>` }))).fetch(place)),
      official,
    );
  const formatted = await harness(
    rss(
      item({
        description:
          '<![CDATA[<P><b>Heavy</b> rain<BR>expected <font color="red">now</font>, <span\tclass="x">rain <5 mm/hr</span></P><div>See <a href="https://evil.example/x">the bulletin</a>.</div><small>IMD</small>]]>',
      }),
    ),
  ).fetch(place);
  assert.equal(text(formatted), 'Heavy rain expected now , rain <5 mm/hr See the bulletin . IMD');
  const attributes = await harness(
    rss(
      item({
        description: `<![CDATA[Rain<br />likely <p align=center>now</p><font face='Arial' size=2>gusts >40 kmph</font> <a target=_blank href="https://evil.example/">here</a>]]>`,
      }),
    ),
  ).fetch(place);
  assert.equal(text(attributes), 'Rain likely now gusts >40 kmph here');
});

test('malformed XML, entity declarations, unexpected feed schema and oversized feeds fail closed', async () => {
  for (const raw of [
    '<rss><channel></rss>',
    '<!DOCTYPE rss [<!ENTITY test "unsafe">]>' + rss(),
    rss().replace('IMD WARNING ', 'Other feed'),
    rss('x'.repeat(1_000_000)),
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
