import test from 'node:test';
import assert from 'node:assert/strict';
import { createNationalAlertAdapter } from '../server/national';
import type { TextOptions } from '../server/http';
import type { Place } from '../src/types';

const now = Date.parse('2026-11-01T00:00:00Z');
const sent = new Date(now - 60_000).toISOString();
const future = new Date(now + 3_600_000).toISOString();
const old = new Date(now - 3_600_000).toISOString();
const manila: Place = {
  id: 'm',
  name: 'Manila',
  country: 'Philippines',
  countryCode: 'PH',
  latitude: 14.6042,
  longitude: 120.9822,
};
const jakarta: Place = {
  id: 'j',
  name: 'Jakarta',
  country: 'Indonesia',
  countryCode: 'ID',
  latitude: -6.21462,
  longitude: 106.84513,
};
const ph = (i: number) =>
  `https://publicalert.pagasa.dost.gov.ph/output/gfa/00000000-0000-4000-8000-${String(i).padStart(12, '0')}.cap`;
const id = (i: number) =>
  `https://www.bmkg.go.id/alerts/nowcast/en/CJK202611010${String(i).padStart(2, '0')}_alert.xml`;
const squarePH = '<polygon>14,120 14,122 16,122 16,120 14,120</polygon>';
const squareID = '<polygon>-7,106 -7,108 -5,108 -5,106 -7,106</polygon>';
function info(
  options: { shape?: string; language?: string; expires?: string | null; title?: string } = {},
) {
  return `<info><language>${options.language ?? 'en'}</language><category>Met</category><event>Flood</event><urgency>Immediate</urgency><severity>Severe</severity><certainty>Observed</certainty><effective>${sent}</effective>${options.expires === null ? '' : `<expires>${options.expires ?? future}</expires>`}<senderName>Official agency</senderName><headline>${options.title ?? 'Flood warning'}</headline><description>Original source description.</description><instruction>Official instructions.</instruction><area><areaDesc>Named district</areaDesc>${options.shape ?? squarePH}</area></info>`;
}
function cap(
  i: number,
  options: { status?: string; scope?: string; type?: string; infos?: string; refs?: string } = {},
) {
  return `<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>alert-${i}</identifier><sender>agency@example.gov</sender><sent>${sent}</sent><status>${options.status ?? 'Actual'}</status><msgType>${options.type ?? 'Alert'}</msgType><scope>${options.scope ?? 'Public'}</scope>${options.refs ? `<references>${options.refs}</references>` : ''}${options.infos ?? info()}</alert>`;
}
function atom(urls: string[], modified = sent) {
  return `<feed xmlns="http://www.w3.org/2005/Atom"><updated>${modified}</updated>${urls.map((url) => `<entry><updated>${sent}</updated><link type="application/cap+xml" href="${url}"/></entry>`).join('')}</feed>`;
}
function rss(urls: string[]) {
  return `<rss version="2.0"><channel><lastBuildDate>${new Date(now).toUTCString()}</lastBuildDate>${urls.map((url) => `<item><link>${url}</link><pubDate>${new Date(sent).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;
}
function harness(feed = atom([ph(1)]), documents = new Map([[ph(1), cap(1)]])) {
  const calls: { url: string; options?: TextOptions }[] = [];
  let active = 0,
    peak = 0;
  const fetch = createNationalAlertAdapter(
    async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/feeds/') || url.endsWith('/nowcast/en'))
        return { text: feed, fetchedAt: now - 1000 };
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      const raw = documents.get(url);
      if (!raw) throw Error('Provider unavailable');
      return { text: raw, fetchedAt: now - 500 };
    },
    { now: () => now },
  );
  return { fetch, calls, peak: () => peak };
}

test('direct PAGASA CAP preserves official point warning and original publication time', async () => {
  const h = harness();
  const r = await h.fetch(manila);
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].url, ph(1));
  assert.equal(r.alerts[0].instruction, 'Official instructions.');
  assert.equal(r.alerts[0].id, 'agency@example.gov/alert-1/0');
  assert.equal(r.source, 'PAGASA · direct official CAP feed');
  assert.equal(r.scope, 'point');
  assert.equal(r.partial, true);
  assert.equal(r.fetchedAt, now - 1000);
  assert.equal(r.feedUpdatedAt, Date.parse(sent));
  assert.deepEqual(r.excludedCapKeys, ['agency@example.gov/alert-1/']);
  assert.match(r.coverage, /not an all-clear/);
});

test('BMKG English RSS uses actual CAP sent instead of generated RSS build time', async () => {
  const r = await harness(
    rss([id(1)]),
    new Map([[id(1), cap(1, { infos: info({ shape: squareID }) })]]),
  ).fetch(jakarta);
  assert.equal(r.alerts.length, 1);
  assert.equal(r.feedUpdatedAt, Date.parse(sent));
  assert.notEqual(r.feedUpdatedAt, now);
  assert.match(r.source, /BMKG/);
  assert.match(r.coverage, /not every earthquake, tsunami/);
});

test('point outside polygon and geometry-free labels cannot be presented as local warnings', async () => {
  const h = harness(
    atom([ph(1), ph(2)]),
    new Map([
      [ph(1), cap(1, { infos: info({ shape: squareID }) })],
      [ph(2), cap(2, { infos: info({ shape: '' }) })],
    ]),
  );
  const r = await h.fetch(manila);
  assert.equal(r.alerts.length, 0);
  assert.equal(r.excludedCapKeys.length, 2);
  assert.match(r.coverage, /no usable point geometry/);
});

test('original CAP circles include nearby point and exclude distant point', async () => {
  const h = harness(
    atom([ph(1)]),
    new Map([[ph(1), cap(1, { infos: info({ shape: '<circle>14.6042,120.9822 2</circle>' }) })]]),
  );
  assert.equal((await h.fetch(manila)).alerts.length, 1);
  assert.equal((await h.fetch({ ...manila, latitude: 15 })).alerts.length, 0);
});

test('expired, future-effective, missing-expiry, test and restricted bulletins do not become current warnings', async () => {
  const docs = new Map([
    [
      ph(1),
      cap(1, {
        infos: info({ expires: old })
          .replace(
            `<effective>${sent}</effective>`,
            `<effective>${new Date(now - 7_200_000).toISOString()}</effective>`,
          )
          .replaceAll(sent, new Date(now - 7_200_000).toISOString()),
      }).replace(`<sent>${sent}</sent>`, `<sent>${new Date(now - 7_200_000).toISOString()}</sent>`),
    ],
    [ph(2), cap(2, { infos: info({ expires: null }) })],
    [ph(3), cap(3, { status: 'Test' })],
    [ph(4), cap(4, { scope: 'Restricted' })],
    [
      ph(5),
      cap(5, {
        infos: info().replace(
          `<effective>${sent}</effective>`,
          `<effective>${new Date(now + 60_000).toISOString()}</effective>`,
        ),
      }),
    ],
  ]);
  const r = await harness(atom([...docs.keys()]), docs).fetch(manila);
  assert.equal(r.alerts.length, 0);
  assert.match(r.coverage, /without a stated expiry/);
  assert.ok(r.excludedCapKeys.includes('agency@example.gov/alert-1/'));
  assert.ok(!r.excludedCapKeys.includes('agency@example.gov/alert-3/'));
  assert.ok(!r.excludedCapKeys.includes('agency@example.gov/alert-4/'));
});

test('cancellation and expired updates suppress original and emit WMO exclusion prefixes', async () => {
  const docs = new Map([
    [ph(1), cap(1)],
    [ph(2), cap(2, { type: 'Cancel', infos: '', refs: `agency@example.gov,alert-1,${sent}` })],
  ]);
  const r = await harness(atom([...docs.keys()]), docs).fetch(manila);
  assert.equal(r.alerts.length, 0);
  assert.deepEqual([...r.excludedCapKeys].sort(), [
    'agency@example.gov/alert-1/',
    'agency@example.gov/alert-2/',
  ]);
});

test('national work is bounded at 20 unique documents and 4 simultaneous requests', async () => {
  const docs = new Map(Array.from({ length: 25 }, (_, i) => [ph(i + 1), cap(i + 1)]));
  const h = harness(atom([ph(1), ...docs.keys()]), docs);
  const r = await h.fetch(manila);
  assert.equal(h.calls.length, 21);
  assert.equal(h.peak(), 4);
  assert.equal(r.alerts.length, 20);
  assert.match(r.coverage, /5 additional feed entries were not checked/);
  assert.ok(
    h.calls.every((call) => call.options?.maxBytes === 256_000 && call.options.ttlMs === 60_000),
  );
});

test('a stalled national detail leaves free slots for later verified bulletins', async () => {
  const urls = Array.from({ length: 8 }, (_, index) => ph(index + 1));
  const started: string[] = [];
  let active = 0,
    peak = 0;
  const fetch = createNationalAlertAdapter(
    async (url) => {
      if (url.endsWith('/feeds/')) return { text: atom(urls), fetchedAt: now };
      started.push(url);
      active++;
      peak = Math.max(peak, active);
      if (url === ph(1)) return new Promise(() => {});
      await Promise.resolve();
      active--;
      return { text: cap(urls.indexOf(url) + 1), fetchedAt: now };
    },
    { now: () => now, deadlineMs: 40 },
  );
  const result = await fetch(manila);
  assert.deepEqual(started, urls);
  assert.equal(peak, 4);
  assert.equal(result.alerts.length, 7);
  assert.match(result.coverage, /7 of 8 selected recent bulletins verified/);
  assert.match(result.coverage, /1 selected bulletin\(s\) could not be verified/);
});

test('national deadline stops workers before starting queued details', async () => {
  const urls = Array.from({ length: 8 }, (_, index) => ph(index + 1));
  const started: string[] = [];
  const fetch = createNationalAlertAdapter(
    async (url) => {
      if (url.endsWith('/feeds/')) return { text: atom(urls), fetchedAt: now };
      started.push(url);
      if (url === ph(1)) return { text: cap(1), fetchedAt: now };
      return new Promise(() => {});
    },
    { now: () => now, deadlineMs: 40 },
  );
  const result = await fetch(manila);
  assert.deepEqual(started, urls.slice(0, 5));
  assert.equal(result.alerts.length, 1);
  assert.match(result.coverage, /4 selected bulletin\(s\) could not be verified/);
  assert.match(result.coverage, /3 additional feed entries were not checked/);
});

test('head failure, malformed payloads and total detail failure reject instead of empty success', async () => {
  const failure = createNationalAlertAdapter(async () => {
    throw Error('Source offline');
  });
  await assert.rejects(failure(manila), /Source offline/);
  for (const raw of [
    '<html>not feed</html>',
    '<feed xmlns="fake"/>',
    '<!DOCTYPE feed [<!ENTITY x SYSTEM "file:///private">]><feed/>',
    atom([ph(1)]).replace('application/cap+xml', 'text/html'),
  ])
    await assert.rejects(harness(raw).fetch(manila));
  await assert.rejects(harness(atom([ph(9)])).fetch(manila), /details could not be verified/);
});

test('untrusted detail URLs never become outgoing fetch targets', async () => {
  for (const url of [
    'https://attacker.example/alert.cap',
    'https://publicalert.pagasa.dost.gov.ph/output/gfa/../../secret.cap',
    'https://publicalert.pagasa.dost.gov.ph/output/gfa/%2e%2e/secret.cap',
    `${ph(1)}?secret=1`,
    'https://publicalert.pagasa.dost.gov.ph/output/other/00000000-0000-4000-8000-000000000001.cap',
  ]) {
    const h = harness(atom([url]));
    await assert.rejects(h.fetch(manila));
    assert.equal(h.calls.length, 1);
  }
});

test('partial detail failure retains verified warning with visible incomplete coverage', async () => {
  const r = await harness(atom([ph(1), ph(2)])).fetch(manila);
  assert.equal(r.alerts.length, 1);
  assert.match(r.coverage, /1 selected bulletin\(s\) could not be verified/);
});

test('empty provider feed has unknown bulletin time and no all-clear claim', async () => {
  const r = await harness(atom([])).fetch(manila);
  assert.equal(r.alerts.length, 0);
  assert.equal(r.feedUpdatedAt, null);
  assert.equal(r.partial, true);
  assert.match(r.coverage, /not an all-clear/);
});

test('caller abort terminates while a shared source fill remains pending', async () => {
  const controller = new AbortController();
  const fetch = createNationalAlertAdapter(() => new Promise(() => {}));
  const pending = fetch(manila, controller.signal);
  controller.abort(new Error('Location changed'));
  await assert.rejects(pending, /Location changed/);
});

test('deadline preserves verified partial data and discloses unverified selected records', async () => {
  const fetch = createNationalAlertAdapter(
    async (url) => {
      if (url.endsWith('/feeds/')) return { text: atom([ph(1), ph(2)]), fetchedAt: now };
      if (url === ph(1)) return { text: cap(1), fetchedAt: now };
      return new Promise(() => {});
    },
    { now: () => now, deadlineMs: 20 },
  );
  const r = await fetch(manila);
  assert.equal(r.alerts.length, 1);
  assert.match(r.coverage, /1 selected bulletin\(s\) could not be verified/);
});

test('English preference preserves all English warning text blocks', async () => {
  const raw = cap(1, {
    infos:
      info({ language: 'fil', title: 'Filipino' }) +
      info({ language: 'en', title: 'English flood' }) +
      info({ language: 'en', title: 'English storm' }),
  });
  const r = await harness(atom([ph(1)]), new Map([[ph(1), raw]])).fetch(manila);
  assert.deepEqual(
    r.alerts.map((a) => a.title),
    ['English flood', 'English storm'],
  );
});

test('future feed timestamps and invalid coordinates are rejected', async () => {
  await assert.rejects(harness(atom([], future)).fetch(manila), /timestamp/);
  await assert.rejects(
    harness().fetch({ ...manila, latitude: NaN }),
    /Invalid official warning location/,
  );
});

test('an expired update still excludes its original from supplemental WMO warnings', async () => {
  const earlier = new Date(now - 7_200_000).toISOString();
  const update = cap(2, {
    type: 'Update',
    refs: `agency@example.gov,alert-1,${sent}`,
    infos: info({ expires: old }).replace(
      `<effective>${sent}</effective>`,
      `<effective>${earlier}</effective>`,
    ),
  }).replace(`<sent>${sent}</sent>`, `<sent>${earlier}</sent>`);
  const documents = new Map([
    [ph(1), cap(1)],
    [ph(2), update],
  ]);
  const result = await harness(atom([...documents.keys()]), documents).fetch(manila);
  assert.equal(result.alerts.length, 0);
  assert.ok(result.excludedCapKeys.includes('agency@example.gov/alert-1/'));
  assert.ok(result.excludedCapKeys.includes('agency@example.gov/alert-2/'));
});

test('PAGASA namespace and CAP link type cannot be replaced by another XML vocabulary', async () => {
  const payloads = [
    atom([ph(1)]).replace(
      'xmlns="http://www.w3.org/2005/Atom"',
      'xmlns="https://attacker.example/Atom"',
    ),
    atom([ph(1)])
      .replace('<entry>', '<wrong:entry xmlns:wrong="https://attacker.example">')
      .replace('</entry>', '</wrong:entry>'),
    atom([ph(1)]).replace('type="application/cap+xml"', 'type="text/html"'),
  ];
  await assert.rejects(harness(payloads[0]).fetch(manila), /official Atom feed/);
  await assert.rejects(harness(payloads[1]).fetch(manila), /namespaced official feed entry/);
  await assert.rejects(harness(payloads[2]).fetch(manila), /CAP bulletin link/);
  await assert.rejects(
    harness(atom([ph(1)]).replace('<entry>', '<entry xmlns="https://attacker.example">')).fetch(
      manila,
    ),
    /namespace/,
  );
  await assert.rejects(
    harness(atom([ph(1)]).replace('<link type=', '<link xmlns="" type=')).fetch(manila),
    /namespace/,
  );
});
