import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCap,
  parseRss,
  newestFirst,
  activeCapRecords,
  capAreaText,
  capReferencesInForce,
  CAP_AREA_TEXT_LIMIT,
  upcomingCapNote,
  upcomingCapRecords,
} from '../server/cap';

const NOW = Date.UTC(2026, 10, 1, 1);
const info = (extra = '') =>
  `<info><language>en-IN</language><category>Met</category><event>Fixture storm</event><urgency>Expected</urgency><severity>Severe</severity><certainty>Likely</certainty><effective>2026-11-01T00:00:00Z</effective><expires>2026-11-01T03:00:00Z</expires><senderName>Fixture authority</senderName><headline>Test &amp; fixture only</headline><description>Fixture description</description><instruction>Original instructions.</instruction><area><areaDesc>Fixture district</areaDesc><geocode><valueName>LGD District Code</valueName><value>469</value></geocode>${extra}</area></info>`;
const xml = (body = info(), top = '') =>
  `<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>fixture-1</identifier><sender>test-authority</sender><sent>2026-11-01T00:00:00Z</sent><status>Actual</status><msgType>Alert</msgType><scope>Public</scope>${top}${body}</alert>`;

test('CAP parser preserves multilingual details, issuer, geocodes, polygon coordinate order and circles', () => {
  const document = parseCap(
    xml(
      info('<polygon>13,80 14,80 14,81 13,80</polygon><circle>13.08,80.27 5.5</circle>') +
        info().replace('en-IN', 'ta-IN'),
    ),
    NOW,
  );
  assert.equal(document.infos.length, 2);
  assert.equal(document.infos[0].senderName, 'Fixture authority');
  assert.equal(document.infos[0].headline, 'Test & fixture only');
  assert.deepEqual(document.infos[0].areas[0].polygons[0][0], [13, 80]);
  assert.deepEqual(document.infos[0].areas[0].circles[0], {
    latitude: 13.08,
    longitude: 80.27,
    radiusKm: 5.5,
  });
  assert.deepEqual(document.infos[0].areas[0].geocodes[0], {
    name: 'LGD District Code',
    value: '469',
  });
});

test('an information block keeps its place in the document when other blocks are filtered out', () => {
  const document = parseCap(
    xml(
      info().replace('2026-11-01T03:00:00Z', '2026-11-01T00:30:00Z') +
        info().replace('en-IN', 'ta-IN') +
        info(),
    ),
    NOW,
  );
  assert.deepEqual(
    document.infos.map((i) => i.position),
    [0, 1, 2],
  );
  // The first block has expired. The others keep the numbers that alert ids are built from, so a
  // block has the same id in every source, however each source filters the document.
  assert.deepEqual(
    activeCapRecords([document], NOW)[0].infos.map((i) => [i.position, i.language]),
    [
      [1, 'ta-IN'],
      [2, 'en-IN'],
    ],
  );
});

test('CAP namespace guard accepts scoped CAP prefixes and unrelated extension content', () => {
  const expected = parseCap(xml(), NOW);
  const prefixed = xml()
    .replace(
      'xmlns="urn:oasis:names:tc:emergency:cap:1.2"',
      'xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2"',
    )
    .replace(/<(\/?)([A-Za-z][\w-]*)(?=[\s>])/g, '<$1cap:$2');
  assert.deepEqual(parseCap(prefixed, NOW), expected);
  const scoped = xml()
    .replace(
      '<status>Actual</status>',
      '<c:status xmlns:c="urn:oasis:names:tc:emergency:cap:1.2">Actual</c:status>',
    )
    .replace(
      '</alert>',
      '<ext:metadata xmlns:ext="urn:example:metadata"><ext:status>Unrelated extension value</ext:status></ext:metadata></alert>',
    );
  assert.deepEqual(parseCap(scoped, NOW), expected);
});

test('CAP namespace guard rejects unused namespace declarations impersonating the root vocabulary', () => {
  const namespace = 'urn:oasis:names:tc:emergency:cap:1.2';
  const invalid = [
    xml().replace(`xmlns="${namespace}"`, `xmlns="urn:foreign" xmlns:unused="${namespace}"`),
    xml().replace(`xmlns="${namespace}"`, `xmlns:unused="${namespace}"`),
    xml()
      .replace('<alert ', '<foreign:alert ')
      .replace('</alert>', '</foreign:alert>')
      .replace(`xmlns="${namespace}"`, `xmlns:foreign="urn:foreign" xmlns:unused="${namespace}"`),
  ];
  for (const source of invalid) assert.throws(() => parseCap(source, NOW), /namespace/i);
});

test('CAP namespace guard rejects foreign consumed fields and scoped prefix/default rebinding', () => {
  const invalid = [
    xml().replace(
      '<status>Actual</status>',
      '<ext:status xmlns:ext="urn:foreign">Actual</ext:status>',
    ),
    xml().replace('<info>', '<info xmlns="urn:foreign">'),
    xml().replace('<area>', '<area xmlns="">'),
    xml()
      .replace('<expires>', '<ext:expires xmlns:ext="urn:foreign">')
      .replace('</expires>', '</ext:expires>'),
    xml()
      .replace('<info>', '<c:info xmlns:c="urn:oasis:names:tc:emergency:cap:1.2">')
      .replace('</info>', '</c:info>')
      .replace(
        '<severity>Severe</severity>',
        '<c:severity xmlns:c="urn:foreign">Severe</c:severity>',
      ),
    xml().replace('<value>469</value>', '<ext:value xmlns:ext="urn:foreign">469</ext:value>'),
    xml().replace('<status>Actual</status>', '<undeclared:status>Actual</undeclared:status>'),
  ];
  for (const source of invalid) assert.throws(() => parseCap(source, NOW), /namespace/i);
});

test('CAP parser decodes XML numeric character references in warning text', () => {
  const document = parseCap(
    xml(
      info()
        .replace('Test &amp; fixture only', 'Don&#39;t cross &#x2014; flooded roads')
        .replace(
          'Original instructions.',
          'Move inland.&#10;Avoid &#x22;low&#x22; areas &amp;#39;',
        ),
    ),
    NOW,
  );
  assert.equal(document.infos[0].headline, "Don't cross — flooded roads");
  // A literal "&#39;" that was itself escaped stays literal; nothing is decoded twice.
  assert.equal(document.infos[0].instruction, 'Move inland.\nAvoid "low" areas &#39;');
});

test('CAP parser rejects malformed XML, entities, oversized payloads and invalid clocks', () => {
  for (const source of [
    xml().slice(0, -5),
    xml().replace('Fixture description', '漢'.repeat(100_000)),
    xml().replace('2026-11-01T00:00:00Z', '2026-11-01T02:00:00Z'),
  ])
    assert.throws(() => parseCap(source, NOW));
  assert.throws(() => parseCap(xml(), NaN));
  // Well-formed: without the guard, the parser would put the entity's text in the headline.
  const entity = `<!DOCTYPE alert [<!ENTITY x "Injected by DTD">]>${xml(info().replace('Test &amp; fixture only', '&x;'))}`;
  for (const source of [
    entity,
    `<?xml version="1.0" encoding="UTF-8"?>${entity}`,
    `<!DOCTYPE alert [<!ENTITY x SYSTEM "file:///private">]>${xml()}`,
    `<!ENTITY x "bad">${xml()}`,
  ])
    assert.throws(() => parseCap(source, NOW), /entities and document types are not accepted/);
  assert.throws(
    () =>
      parseRss(
        '<!DOCTYPE rss [<!ENTITY x "Injected">]><rss version="2.0"><channel><title>&x;</title></channel></rss>',
      ),
    /entities and document types are not accepted/,
  );
  // Every field is within its own limit: only the document as a whole is over 256,000 bytes.
  const padded = (spaces: number) =>
    xml().replace('<identifier>', `${' '.repeat(spaces)}<identifier>`);
  assert.throws(() => parseCap(padded(256_000), NOW), /size limit/);
  assert.equal(parseCap(padded(255_000), NOW).identifier, 'fixture-1');
});

test('province bulletins retain 197 district polygons without dropping original boundaries', () => {
  // Regression for BMKG Papua Pegunungan's 197-polygon source document.
  const ring = '<polygon>-5,105 -5,106 -6,106 -5,105</polygon>';
  const parsed = parseCap(xml(info(ring.repeat(197))), NOW);
  assert.equal(parsed.infos[0].areas[0].polygons.length, 197);
  assert.deepEqual(parsed.infos[0].areas[0].polygons[196][0], [-5, 105]);
  assert.throws(() => parseCap(xml(info(ring.repeat(257))), NOW), /bound/);
});

test('CAP dates require valid dates and explicit timezones; enum and geographic validation fail closed', () => {
  const malformed = [
    xml().replace('2026-11-01T00:00:00Z', '2026-02-30T00:00:00Z'),
    xml().replace('2026-11-01T00:00:00Z', '2026-11-01T00:00:00'),
    xml().replace('<severity>Severe</severity>', '<severity>All clear</severity>'),
    xml().replace('<status>Actual</status>', '<status>Live</status>'),
    xml().replace('urn:oasis:names:tc:emergency:cap:1.2', 'urn:unexpected'),
    xml().replace('<msgType>Alert</msgType>', '<msgType>Cancel</msgType>'),
    xml().replace('2026-11-01T03:00:00Z', '2026-10-31T03:00:00Z'),
    xml(info('<polygon>91,80 14,80 14,81 91,80</polygon>')),
    xml(info('<polygon>13,80 14,80 14,81 12,80</polygon>')),
    xml(info('<circle>13.08,80.27 -1</circle>')),
  ];
  for (const source of malformed) assert.throws(() => parseCap(source, NOW));
});

test('missing expiry is preserved as unknown and never promoted to active', () => {
  const document = parseCap(
    xml(info().replace('<expires>2026-11-01T03:00:00Z</expires>', '')),
    NOW,
  );
  assert.equal(document.infos[0].expires, null);
  assert.deepEqual(activeCapRecords([document], NOW), []);
});

test('Actual/Public eligible infos only; duplicate and expired info cannot become active', () => {
  const live = parseCap(xml(), NOW);
  const testRecord = parseCap(
    xml().replace('<status>Actual</status>', '<status>Test</status>'),
    NOW,
  );
  const privateRecord = parseCap(
    xml().replace('<scope>Public</scope>', '<scope>Private</scope>'),
    NOW,
  );
  assert.equal(activeCapRecords([live, live, testRecord, privateRecord], NOW).length, 1);
  assert.deepEqual(activeCapRecords([live], NOW + 3 * 3_600_000), []);
  assert.deepEqual(activeCapRecords([live], NOW - 2 * 3_600_000), []);
});

test('CAP updates and cancellations suppress referenced originals even if replacement expired', () => {
  const original = parseCap(xml(), NOW);
  const refs = '<references>test-authority,fixture-1,2026-11-01T00:00:00Z</references>';
  const updated = parseCap(
    xml(info(), refs)
      .replace('<identifier>fixture-1</identifier>', '<identifier>fixture-2</identifier>')
      .replace('<msgType>Alert</msgType>', '<msgType>Update</msgType>'),
    NOW,
  );
  assert.deepEqual(
    activeCapRecords([original, updated], NOW).map((d) => d.identifier),
    ['fixture-2'],
  );
  const cancel = parseCap(
    xml('', refs)
      .replace('<identifier>fixture-1</identifier>', '<identifier>cancel-1</identifier>')
      .replace('<msgType>Alert</msgType>', '<msgType>Cancel</msgType>'),
    NOW,
  );
  assert.deepEqual(activeCapRecords([original, cancel], NOW), []);
  const expiredUpdate = {
    ...updated,
    infos: updated.infos.map((i) => ({ ...i, expires: NOW - 1 })),
  };
  assert.deepEqual(activeCapRecords([original, expiredUpdate], NOW), []);
  const testCancel = { ...cancel, status: 'Test' };
  assert.equal(activeCapRecords([original, testCancel], NOW).length, 1);
});

test('RSS uses latest item publication over an old channel date and bounds its list', () => {
  const item =
    '<item><link>https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=123</link><pubDate>Sun, 01 Nov 2026 00:00:00 GMT</pubDate></item>';
  const feed = parseRss(
    `<rss><channel><pubDate>Fri, 16 Oct 2026 00:00:00 GMT</pubDate>${item.repeat(101)}</channel></rss>`,
  );
  assert.equal(feed.updatedAt, NOW - 3_600_000);
  // Every entry is read, up to 1,000; a longer list is rejected, never cut short.
  assert.equal(feed.items.length, 101);
  assert.throws(
    () => parseRss(`<rss><channel>${item.repeat(1001)}</channel></rss>`),
    /exceeds its bound/,
  );
  assert.deepEqual(parseRss('<rss><channel><title>Empty feed</title></channel></rss>'), {
    items: [],
    updatedAt: null,
    unzonedTimes: false,
  });
  assert.throws(() =>
    parseRss(
      '<rss><channel><item><link>url</link><pubDate>bad date</pubDate></item></channel></rss>',
    ),
  );
});

test('a feed of more than 100 entries is ordered as a whole, so its newest entry is read first wherever it is listed', () => {
  // 101 entries listed oldest first, a minute apart; the last one is the most recent.
  const published = (id: number) => NOW - (102 - id) * 60_000;
  const feed = parseRss(
    `<rss><channel>${Array.from(
      { length: 101 },
      (_, i) =>
        `<item><link>https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=${i + 1}</link><pubDate>${new Date(published(i + 1)).toUTCString()}</pubDate></item>`,
    ).join('')}</channel></rss>`,
  );
  const { items, certain } = newestFirst(feed.items);
  assert.deepEqual(
    items.slice(0, 3).map((item) => Number(item.url.split('=')[1])),
    [101, 100, 99],
  );
  assert.equal(certain, true);
  assert.equal(feed.updatedAt, published(101));
});

test('RSS times without a time zone are unknown, never read in the server time zone', () => {
  const feed = (channel: string, published: string) =>
    `<rss><channel>${channel}<item><link>https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=1</link><pubDate>${published}</pubDate></item></channel></rss>`;
  // 05:30 in India is 00:00 UTC; a UTC server read it as 05:30 UTC, 5.5 hours in the future.
  const local = parseRss(
    feed(
      '<lastBuildDate>Sun, 01 Nov 2026 00:10:00 GMT</lastBuildDate>',
      'Sun, 01 Nov 2026 05:30:00',
    ),
  );
  assert.equal(local.items[0].publishedAt, null);
  assert.equal(local.updatedAt, Date.UTC(2026, 10, 1, 0, 10));
  assert.equal(local.unzonedTimes, true);
  // Its clock reading still places it among the entries of its feed; it is not an instant.
  assert.equal(local.items[0].order, Date.UTC(2026, 10, 1, 5, 30));
  const unknown = parseRss(
    feed('<pubDate>2026-11-01T05:30:00</pubDate>', 'Sun, 01 Nov 2026 05:30'),
  );
  assert.deepEqual(
    [unknown.items[0].publishedAt, unknown.updatedAt, unknown.unzonedTimes],
    [null, null, true],
  );
  for (const zoned of [
    'Sun, 01 Nov 2026 00:00:00 GMT',
    'Sun, 01 Nov 2026 00:00:00 UT',
    'Sun, 01 Nov 2026 05:30:00 +0530',
    'Sat, 31 Oct 2026 20:00:00 EDT',
    '2026-11-01T00:00:00Z',
    '2026-11-01T05:30:00+05:30',
    // The zone is not the last token: a year, an offset or a comment follows it.
    'Sun Nov 01 00:00:00 UTC 2026',
    'Sun Nov 01 05:30:00 GMT+05:30 2026',
    'Sun, 01 Nov 2026 05:30:00 +0530 (IST)',
    'Sun Nov 01 2026 05:30:00 GMT+0530 (India Standard Time)',
    'Sun, 01 Nov 2026 05:00:00 +05',
    '2026-11-01 05:30:00 +0530',
    'Sun, 01 Nov 2026 05:30:00 (IST) +0530',
    'Sun, 01 Nov 2026 5:30:00 AM+0530',
  ]) {
    const parsed = parseRss(feed('', zoned));
    assert.equal(parsed.items[0].publishedAt, Date.UTC(2026, 10, 1), zoned);
    assert.equal(parsed.items[0].order, Date.UTC(2026, 10, 1), zoned);
    assert.equal(parsed.unzonedTimes, false, zoned);
  }
  // A zone named only in a comment is skipped by the date parser, so the time has no zone.
  for (const comment of [
    'Sun Nov 01 2026 05:30:00 (IST)',
    'Sun Nov 01 2026 05:30:00 (GMT+0530)',
    'Sun Nov 01 2026 05:30:00 ((IST) GMT)',
    'Sun Nov 01 2026 05:30:00 (IST GMT',
    '(00:00 GMT) Sun Nov 01 2026 05:30:00',
  ]) {
    const parsed = parseRss(feed('', comment));
    assert.deepEqual(
      [parsed.items[0].publishedAt, parsed.items[0].order, parsed.unzonedTimes],
      [null, Date.UTC(2026, 10, 1, 5, 30), true],
      comment,
    );
  }
  // An unreadable time still fails closed.
  assert.throws(() => parseRss(feed('', 'Sun, 01 Nov 2026 05:30:00 IST')), /publication time/);
});

test('a feed time is read the same in every server time zone: an instant only when it names its zone', () => {
  const feed = (published: string) =>
    `<rss><channel><item><link>https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=1</link><pubDate>${published}</pubDate></item></channel></rss>`;
  const forms = [
    'Sat, 07 Nov 2026 15:30:00 GMT',
    'Sat, 07 Nov 2026 15:30:00 UT',
    'Sat, 07 Nov 2026 15:30:00 Z',
    'Sat, 07 Nov 2026 15:30:00 +0530',
    'Sat, 07 Nov 2026 15:30:00 +05:30',
    'Sat, 07 Nov 2026 15:30:00 +05',
    'Sat, 07 Nov 2026 15:30:00 -07',
    'Sat, 07 Nov 2026 15:30:00+0530',
    'Sat, 07 Nov 2026 15:30:00 EDT',
    'Sat, 07 Nov 2026 15:30:00 PST',
    'Sat, 07 Nov 2026 15:30 GMT',
    'Sat, 07 Nov 2026 15:30:00 GMT+5:30',
    'Sat Nov 07 15:30:00 UTC 2026',
    'Sat Nov 07 15:30:00 GMT+05:30 2026',
    'Sat Nov 07 15:30:00 GMT+0530 2026',
    'Sat Nov 07 2026 15:30:00 +0530 (IST)',
    'Sat Nov 07 2026 15:30:00 GMT+0530 (India Standard Time)',
    'Sat Nov 07 2026 15:30:00 GMT (comment)',
    'Sat Nov 07 2026 15:30:00 UTC+5',
    '15:30:00 Nov 07 2026 -0500',
    '07 Nov 2026 03:30:00 PM +0530',
    '11/07/2026 15:30:00 GMT+0530',
    '2026-11-07T15:30:00Z',
    '2026-11-07T15:30:00.123+05:30',
    '2026-11-07T15:30:00+0530',
    '2026-11-07 15:30:00 UTC',
    'Sat Nov 07 2026 15:30:00 (IST) +0530',
    'Sat Nov 07 2026 15:30:00 (a (nested) comment) GMT',
    '07 Nov 2026 03:30:00 PM+0530',
    // No zone: the instant is unknown everywhere, and the ordering key is the clock reading.
    'Sat, 07 Nov 2026 15:30:00',
    'Sat, 07 Nov 2026 15:30',
    'Sat, 07 Nov 2026 15:30:00 ',
    'Sat Nov 07 15:30:00 2026',
    'Sat Nov 07 2026 15:30:00 (IST)',
    'Sat Nov 07 2026 15:30:00 (UTC+05:30)',
    'Sat Nov 07 2026 15:30:00 (+0530)',
    'Sat Nov 07 2026 15:30:00 (IST GMT',
    '(12:00 GMT) Sat Nov 07 2026 15:30:00',
    '15:30:00 07-Nov-2026',
    '15:30:00 2026-11-07',
    '07 Nov 2026 03:30:00 PM',
    '11/07/2026 15:30:00',
    '15:30:00 Nov 07 2026',
    '2026-11-07T15:30:00',
    '2026-11-07 15:30:00',
  ];
  const original = process.env.TZ;
  const read = (zone: string) => {
    process.env.TZ = zone;
    return forms.map((form) => parseRss(feed(form)).items[0]);
  };
  try {
    const utc = read('UTC');
    for (const zone of ['Asia/Kolkata', 'America/New_York', 'Pacific/Auckland'])
      assert.deepEqual(read(zone), utc, zone);
    for (const [index, item] of utc.entries()) {
      const zoned = index < forms.indexOf('Sat, 07 Nov 2026 15:30:00');
      assert.equal(item.publishedAt !== null, zoned, forms[index]);
      // In UTC a time without a zone parses to its own clock reading: that is its ordering key.
      if (!zoned) assert.equal(item.order, Date.UTC(2026, 10, 7, 15, 30), forms[index]);
      else assert.equal(item.order, item.publishedAt, forms[index]);
    }
    // A date alone names no zone either; it orders by its day in every server zone.
    for (const zone of ['UTC', 'Asia/Kolkata', 'America/New_York']) {
      process.env.TZ = zone;
      for (const day of ['2026-11-07', 'Sat, 07 Nov 2026'])
        assert.deepEqual(
          parseRss(feed(day)).items[0],
          {
            url: parseRss(feed(day)).items[0].url,
            publishedAt: null,
            order: Date.UTC(2026, 10, 7),
          },
          `${day} in ${zone}`,
        );
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('feed entries are ordered newest first; times without a zone order one feed, mixed or missing times do not', () => {
  const entry = (id: number, published?: string) =>
    `<item><link>https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=${id}</link>${published === undefined ? '' : `<pubDate>${published}</pubDate>`}</item>`;
  const order = (...entries: string[]) => {
    const { items, certain } = newestFirst(
      parseRss(`<rss><channel>${entries.join('')}</channel></rss>`).items,
    );
    return [items.map((item) => Number(item.url.split('=')[1])), certain];
  };
  assert.deepEqual(
    order(
      entry(1, 'Sun, 01 Nov 2026 03:00:00 GMT'),
      entry(2, 'Sun, 01 Nov 2026 05:00:00 GMT'),
      entry(3, 'Sun, 01 Nov 2026 04:00:00 GMT'),
    ),
    [[2, 3, 1], true],
  );
  // Zone-less times of one feed share a zone, so their clock readings order them.
  assert.deepEqual(
    order(
      entry(1, 'Sun, 01 Nov 2026 03:00:00'),
      entry(2, 'Sun, 01 Nov 2026 05:00:00'),
      entry(3, 'Sat, 31 Oct 2026 23:00:00'),
    ),
    [[2, 1, 3], true],
  );
  // An entry without a time follows the dated ones in feed order; the order is then uncertain.
  assert.deepEqual(order(entry(1), entry(2, 'Sun, 01 Nov 2026 05:00:00 GMT'), entry(3)), [
    [2, 1, 3],
    false,
  ]);
  // A clock reading cannot be compared with an instant.
  assert.equal(
    order(entry(1, 'Sun, 01 Nov 2026 03:00:00'), entry(2, 'Sun, 01 Nov 2026 05:00:00 GMT'))[1],
    false,
  );
  assert.deepEqual(newestFirst([]), { items: [], certain: true });
});

test('the deprecated CAP 1.0 certainty "Very Likely" is read as Likely, not rejected', () => {
  const veryLikely = (body: string) =>
    body.replace('<certainty>Likely</certainty>', '<certainty>Very Likely</certainty>');
  assert.deepEqual(parseCap(veryLikely(xml()), NOW), parseCap(xml(), NOW));
  // An escalating Update that uses it still supersedes the original it references.
  const refs = '<references>test-authority,fixture-1,2026-11-01T00:00:00Z</references>';
  const update = parseCap(
    veryLikely(xml(info(), refs))
      .replace('<identifier>fixture-1</identifier>', '<identifier>fixture-2</identifier>')
      .replace('<msgType>Alert</msgType>', '<msgType>Update</msgType>'),
    NOW,
  );
  assert.equal(update.infos[0].certainty, 'Likely');
  assert.deepEqual(
    activeCapRecords([parseCap(xml(), NOW), update], NOW).map((d) => d.identifier),
    ['fixture-2'],
  );
  for (const value of ['very likely', 'VeryLikely', 'Very  Likely'])
    assert.throws(() =>
      parseCap(
        xml().replace('<certainty>Likely</certainty>', `<certainty>${value}</certainty>`),
        NOW,
      ),
    );
});

test('a Cancel or Update whose information ends at its issue time still withdraws the original', () => {
  const original = parseCap(xml(), NOW);
  const refs = '<references>test-authority,fixture-1,2026-11-01T00:00:00Z</references>';
  const sent = '2026-11-01T00:30:00Z';
  const message = (type: string, body: string) =>
    parseCap(
      xml(body, refs)
        .replace('<identifier>fixture-1</identifier>', `<identifier>${type}-1</identifier>`)
        .replace('<msgType>Alert</msgType>', `<msgType>${type}</msgType>`)
        .replace('<sent>2026-11-01T00:00:00Z</sent>', `<sent>${sent}</sent>`),
      NOW,
    );
  const endsNow = info().replace('2026-11-01T03:00:00Z', sent);
  for (const cancel of [
    message('Cancel', endsNow),
    // Effective time defaults to the issue time, so this information also ends as it starts.
    message('Cancel', endsNow.replace('<effective>2026-11-01T00:00:00Z</effective>', '')),
    message('Cancel', info().replace('2026-11-01T03:00:00Z', '2026-11-01T00:29:30Z')),
  ])
    assert.deepEqual(activeCapRecords([original, cancel], NOW), []);
  // An Update that ends one area now and extends another replaces the original.
  const update = message(
    'Update',
    endsNow + info().replace('2026-11-01T03:00:00Z', '2026-11-01T06:00:00Z'),
  );
  const active = activeCapRecords([original, update], NOW);
  assert.deepEqual(
    active.map((d) => [d.identifier, d.infos.map((i) => i.expires)]),
    [['Update-1', [Date.UTC(2026, 10, 1, 6)]]],
  );
  // An Update's information that ends before it starts, or by its issue time, is never current.
  const inverted = message(
    'Update',
    info().replace('2026-11-01T03:00:00Z', '2026-10-31T03:00:00Z'),
  );
  assert.deepEqual(activeCapRecords([original, inverted], NOW), []);
  // Still unexpired on this clock, but issued (slightly ahead of it) after its own expiry.
  const aheadAt = '<sent>2026-11-01T01:04:00Z</sent>';
  const endsBeforeIssue = info().replace('2026-11-01T03:00:00Z', '2026-11-01T01:02:00Z');
  const issuedAhead = parseCap(
    xml(endsBeforeIssue, refs)
      .replace('<identifier>fixture-1</identifier>', '<identifier>ahead-1</identifier>')
      .replace('<msgType>Alert</msgType>', '<msgType>Update</msgType>')
      .replace('<sent>2026-11-01T00:00:00Z</sent>', aheadAt),
    NOW,
  );
  assert.deepEqual(activeCapRecords([issuedAhead], NOW), []);
  assert.deepEqual(upcomingCapRecords([inverted, issuedAhead], NOW), []);
});

test('an original Alert whose expiry is not after its issue and effective times is rejected, never read as a warning that is not shown', () => {
  const ends = (expires: string) => info().replace('2026-11-01T03:00:00Z', expires);
  for (const source of [
    // A mistyped date: the warning "expires" the day before it was issued.
    xml(ends('2026-10-31T03:00:00Z')),
    xml(ends('2026-11-01T00:00:00Z')),
    // After the issue time, but not after a later effective time.
    xml(ends('2026-11-01T02:00:00Z')).replace(
      '<effective>2026-11-01T00:00:00Z</effective>',
      '<effective>2026-11-01T02:30:00Z</effective>',
    ),
    // Unexpired on this clock, but issued after its own expiry.
    xml(ends('2026-11-01T01:02:00Z')).replace(
      '<sent>2026-11-01T00:00:00Z</sent>',
      '<sent>2026-11-01T01:04:00Z</sent>',
    ),
  ])
    assert.throws(() => parseCap(source, NOW), /validity interval/);
  // The same information in a Cancel or an Update is valid CAP: it ends the warning it references.
  const refs = '<references>test-authority,fixture-1,2026-11-01T00:00:00Z</references>';
  for (const type of ['Cancel', 'Update'])
    assert.equal(
      parseCap(
        xml(ends('2026-10-31T03:00:00Z'), refs).replace(
          '<msgType>Alert</msgType>',
          `<msgType>${type}</msgType>`,
        ),
        NOW,
      ).infos[0].expires,
      Date.UTC(2026, 9, 31, 3),
    );
});

test('information that takes effect later is upcoming, never current, and an Update waits for it', () => {
  const effectiveAt = (body: string, effective: string, expires = '2026-11-01T12:00:00Z') =>
    body
      .replace('<effective>2026-11-01T00:00:00Z</effective>', `<effective>${effective}</effective>`)
      .replace('2026-11-01T03:00:00Z', expires);
  const advance = parseCap(
    xml(effectiveAt(info(), '2026-11-01T06:00:00Z')).replace('fixture-1<', 'advance-1<'),
    NOW,
  );
  assert.deepEqual(activeCapRecords([advance], NOW), []);
  assert.deepEqual(
    upcomingCapRecords([advance], NOW).map((d) => d.identifier),
    ['advance-1'],
  );
  assert.equal(activeCapRecords([advance], Date.UTC(2026, 10, 1, 6)).length, 1);
  assert.deepEqual(upcomingCapRecords([advance], Date.UTC(2026, 10, 1, 6)), []);
  assert.equal(
    upcomingCapNote([Date.UTC(2026, 10, 1, 9), Date.UTC(2026, 10, 1, 6)], 'matched bulletin(s)'),
    ' 2 matched bulletin(s) take effect later and are not listed as current warnings yet; the earliest takes effect at 2026-11-01T06:00:00.000Z.',
  );
  assert.equal(upcomingCapNote([], 'matched bulletin(s)'), '');
  // A future-effective Update leaves the original current until the Update takes effect.
  const original = parseCap(xml(), NOW);
  const refs = '<references>test-authority,fixture-1,2026-11-01T00:00:00Z</references>';
  const reissue = (type: string) =>
    parseCap(
      xml(effectiveAt(info(), '2026-11-01T02:00:00Z'), refs)
        .replace('fixture-1<', `${type}-1<`)
        .replace('<msgType>Alert</msgType>', `<msgType>${type}</msgType>`),
      NOW,
    );
  const update = reissue('Update');
  assert.equal(capReferencesInForce(update, NOW), false);
  assert.deepEqual(
    activeCapRecords([original, update], NOW).map((d) => d.identifier),
    ['fixture-1'],
  );
  assert.deepEqual(
    upcomingCapRecords([original, update], NOW).map((d) => d.identifier),
    ['Update-1'],
  );
  const effective = Date.UTC(2026, 10, 1, 2);
  assert.equal(capReferencesInForce(update, effective), true);
  assert.deepEqual(
    activeCapRecords([original, update], effective).map((d) => d.identifier),
    ['Update-1'],
  );
  // A Cancel withdraws at once, whatever time its information states.
  const cancel = reissue('Cancel');
  assert.equal(capReferencesInForce(cancel, NOW), true);
  assert.deepEqual(activeCapRecords([original, cancel], NOW), []);
  assert.deepEqual(upcomingCapRecords([original, cancel], NOW), []);
});

test('a long area list keeps whole leading names and states how many more the bulletin names', () => {
  const areas = (names: string[]) =>
    names.map((description) => ({ description, polygons: [], circles: [], geocodes: [] }));
  // Up to the 4,000-character bound the names are joined unchanged.
  const exact = areas(['x'.repeat(1998), 'y'.repeat(2000)]);
  assert.equal(capAreaText(exact), `${'x'.repeat(1998)}; ${'y'.repeat(2000)}`);
  assert.equal(
    capAreaText(areas(['x'.repeat(1999), 'y'.repeat(2000)])),
    `${'x'.repeat(1999)} … [1 more area(s) named in the official bulletin]`,
  );
  // 100 block names (about 4,900 characters) with Howrah last: never cut mid-name or silently.
  const blocks = Array.from({ length: 100 }, (_, i) =>
    i === 99
      ? 'Block 100, Howrah district'
      : `Block ${i + 1}, Purba Medinipur district, West Bengal`,
  );
  const text = capAreaText(areas(blocks));
  assert.ok(text.length <= CAP_AREA_TEXT_LIMIT, String(text.length));
  const [shown, note] = text.split(' … ');
  const kept = shown.split('; ');
  assert.deepEqual(kept, blocks.slice(0, kept.length));
  assert.ok(kept.length > 60 && kept.length < 100, String(kept.length));
  assert.equal(note, `[${100 - kept.length} more area(s) named in the official bulletin]`);
  // A single name longer than the bound is shortened at a word, and says so.
  const long = capAreaText(areas([`${'Village '.repeat(700)}end`, 'Howrah']));
  assert.ok(long.length <= CAP_AREA_TEXT_LIMIT, String(long.length));
  assert.match(
    long,
    /^Village(?: Village)* … \[area text shortened; 1 more area\(s\); see the official bulletin\]$/,
  );
  assert.equal(capAreaText([]), '');
});
