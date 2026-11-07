import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCap, parseRss, activeCapRecords } from '../server/cap';

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
    `<!DOCTYPE alert [<!ENTITY x SYSTEM "file:///private">]>${xml()}`,
    `<!ENTITY x "bad">${xml()}`,
    xml().replace('Fixture description', '漢'.repeat(100_000)),
    xml().replace('2026-11-01T00:00:00Z', '2026-11-01T02:00:00Z'),
  ])
    assert.throws(() => parseCap(source, NOW));
  assert.throws(() => parseCap(xml(), NaN));
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
  assert.equal(feed.items.length, 100);
  assert.equal(feed.truncated, true);
  assert.deepEqual(parseRss('<rss><channel><title>Empty feed</title></channel></rss>'), {
    items: [],
    updatedAt: null,
    truncated: false,
  });
  assert.throws(() =>
    parseRss(
      '<rss><channel><item><link>url</link><pubDate>bad date</pubDate></item></channel></rss>',
    ),
  );
});
