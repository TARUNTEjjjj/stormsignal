import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchIndiaAlerts, indiaRegion, INDIA_REGIONS } from '../server/india';
import type { Place } from '../src/types';
import type { TextOptions } from '../server/http';

const NOW = Date.UTC(2026, 10, 1, 1);
const place: Place = {
  id: '1275339',
  name: 'Mumbai',
  latitude: 19.07283,
  longitude: 72.88261,
  country: 'India',
  countryCode: 'IN',
  admin: 'Maharashtra',
  timezone: 'Asia/Kolkata',
};
const link = (id: number) =>
  `https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=${id}`;
const feed = (links = [link(1)], date = 'Sun, 01 Nov 2026 00:00:00 GMT') =>
  `<rss><channel><pubDate>${date}</pubDate>${links.map((url) => `<item><link>${url.replace(/&/g, '&amp;')}</link><pubDate>${date}</pubDate></item>`).join('')}</channel></rss>`;
const cap = (id = 1, type = 'Alert', reference = '') =>
  `<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>fixture-${id}</identifier><sender>IMD-fixture</sender><sent>2026-11-01T00:00:00Z</sent><status>Actual</status><msgType>${type}</msgType><scope>Public</scope>${reference ? `<references>${reference}</references>` : ''}${type === 'Cancel' ? '' : '<info><language>en-IN</language><category>Met</category><event>Fixture heavy rain</event><urgency>Expected</urgency><severity>Severe</severity><certainty>Likely</certainty><effective>2026-11-01T00:00:00Z</effective><expires>2026-11-01T03:00:00Z</expires><headline>Fixture warning for Raigad</headline><instruction>Original fixture instructions.</instruction><area><areaDesc>Raigad district of Maharashtra</areaDesc></area></info>'}</alert>`;
const request =
  (rss = feed(), documents: Record<string, string | Error> = { [link(1)]: cap() }) =>
  async (url: string, _options?: TextOptions) => {
    if (url.includes('/rss/')) return { text: rss, fetchedAt: NOW };
    const text = documents[url];
    if (text instanceof Error) throw text;
    if (!text) throw new Error('Unexpected request');
    return { text, fetchedAt: NOW };
  };

test('India state mapping is fixed, supports all 36 published entries and priority regions', () => {
  assert.equal(INDIA_REGIONS.length, 36);
  for (const [name, slug] of INDIA_REGIONS)
    assert.equal(
      indiaRegion({ ...place, admin: name })?.url,
      `https://sachet.ndma.gov.in/cap_public_website/rss/rss_${slug}.xml`,
    );
  assert.equal(indiaRegion({ ...place, admin: 'Odisha' })?.name, 'Odisha');
  assert.equal(indiaRegion({ ...place, admin: 'Tamil Nadu' })?.name, 'Tamil Nadu');
  assert.equal(indiaRegion({ ...place, admin: 'Orissa' })?.name, 'Odisha');
  assert.equal(indiaRegion({ ...place, admin: 'https://evil.example' }), null);
  assert.equal(indiaRegion({ ...place, countryCode: 'US' }), null);
});

test('India warning response is explicitly regional and partial, with original area and source times', async () => {
  const result = await fetchIndiaAlerts(place, { now: NOW, request: request() });
  assert.equal(result.status, 'available');
  assert.equal(result.scope, 'region');
  assert.equal(result.scopeLabel, 'Maharashtra');
  assert.equal(result.partial, true);
  assert.equal(result.feedUpdatedAt, NOW - 3_600_000);
  assert.equal(result.alerts[0].area, 'Raigad district of Maharashtra');
  assert.equal(result.alerts[0].instruction, 'Original fixture instructions.');
  assert.equal(result.alerts[0].url, link(1));
  assert.equal(result.alerts[0].geometry, null);
  assert.match(result.coverage, /not automatically to Mumbai/);
  assert.match(result.coverage, /not establish local coverage or an all-clear/);
});

test('Kolkata selects the West Bengal feed and preserves another district without relabeling it local', async () => {
  const calls: string[] = [];
  const kolkata: Place = {
    ...place,
    id: '1275004',
    name: 'Kolkata',
    admin: 'West Bengal',
    latitude: 22.56263,
    longitude: 88.36304,
  };
  const source = cap().replaceAll('Raigad', 'Darjeeling').replaceAll('Maharashtra', 'West Bengal');
  const result = await fetchIndiaAlerts(kolkata, {
    now: NOW,
    request: async (url) => {
      calls.push(url);
      return { text: url.includes('/rss/') ? feed() : source, fetchedAt: NOW };
    },
  });
  assert.deepEqual(calls, [
    'https://sachet.ndma.gov.in/cap_public_website/rss/rss_west.xml',
    link(1),
  ]);
  assert.equal(result.scopeLabel, 'West Bengal');
  assert.equal(result.scope, 'region');
  assert.equal(result.partial, true);
  assert.equal(result.alerts[0].area, 'Darjeeling district of West Bengal');
  assert.match(result.coverage, /not automatically to Kolkata/);
  assert.match(result.coverage, /does not establish local coverage or an all-clear/);
});

test('a fresh West Bengal feed does not revive an expired Kolkata bulletin', async () => {
  const result = await fetchIndiaAlerts(
    { ...place, name: 'Kolkata', admin: 'West Bengal' },
    {
      now: NOW,
      request: request(feed(), {
        [link(1)]: cap().replaceAll('2026-11-01', '2026-10-31'),
      }),
    },
  );
  assert.equal(result.status, 'available');
  assert.equal(result.scopeLabel, 'West Bengal');
  assert.equal(result.feedUpdatedAt, NOW - 3_600_000);
  assert.deepEqual(result.alerts, []);
  assert.equal(result.partial, true);
  assert.match(result.coverage, /does not establish local coverage or an all-clear/);
});

test('old readable feed is historical coverage, not a fabricated current heartbeat or live warning', async () => {
  const result = await fetchIndiaAlerts(
    { ...place, name: 'Chennai', admin: 'Tamil Nadu' },
    {
      now: NOW,
      request: request(feed([link(1)], 'Mon, 26 Oct 2026 00:00:00 GMT'), {
        [link(1)]: cap().replaceAll('2026-11-01', '2026-10-26'),
      }),
    },
  );
  assert.equal(result.alerts.length, 0);
  assert.equal(result.feedUpdatedAt, Date.UTC(2026, 9, 26));
  assert.match(result.coverage, /Latest bulletin in this feed: 2026-10-26/);
  assert.match(result.coverage, /Current regional coverage is unverified/);
  assert.equal(result.partial, true);
});

test('unknown region avoids requests and missing publication time remains explicitly unverified', async () => {
  const unknown = await fetchIndiaAlerts(
    { ...place, admin: undefined },
    {
      now: NOW,
      request: async () => {
        throw new Error('must not fetch');
      },
    },
  );
  assert.equal(unknown.status, 'unsupported');
  const empty = await fetchIndiaAlerts(place, {
    now: NOW,
    request: request('<rss><channel><title>Empty</title></channel></rss>'),
  });
  assert.equal(empty.feedUpdatedAt, null);
  assert.match(empty.coverage, /No bulletin publication time/);
  assert.equal(empty.partial, true);
});

test('feed times without a time zone are unknown: the feed stays available and says so', async () => {
  // NOW is 06:30 in India. A zone-less 05:30 bulletin was read by a UTC server as 4.5 h ahead
  // (the whole feed then failed), and by an IST machine as one hour old.
  const result = await fetchIndiaAlerts(place, {
    now: NOW,
    request: request(feed([link(1)], 'Sun, 01 Nov 2026 05:30:00')),
  });
  assert.equal(result.status, 'available');
  assert.equal(result.alerts.length, 1);
  assert.equal(result.feedUpdatedAt, null);
  assert.match(
    result.coverage,
    /Feed publication times have no time zone, so the latest bulletin time is unknown\. Current regional coverage is unverified/,
  );
  // A zoned channel time is still used, and the zone-less entry times are disclosed.
  const mixed = await fetchIndiaAlerts(place, {
    now: NOW,
    request: request(
      `<rss><channel><lastBuildDate>Sun, 01 Nov 2026 00:30:00 GMT</lastBuildDate><item><link>${link(1)}</link><pubDate>Sun, 01 Nov 2026 05:30:00</pubDate></item></channel></rss>`,
    ),
  });
  assert.equal(mixed.feedUpdatedAt, Date.UTC(2026, 10, 1, 0, 30));
  assert.match(
    mixed.coverage,
    /Some feed publication times have no time zone; they only set the order in which entries are read\./,
  );
});

test('a regional bulletin taking effect later is disclosed; a pending Update keeps the original', async () => {
  const later = (raw: string) =>
    raw
      .replace(
        '<effective>2026-11-01T00:00:00Z</effective>',
        '<effective>2026-11-01T06:00:00Z</effective>',
      )
      .replace('2026-11-01T03:00:00Z', '2026-11-01T12:00:00Z');
  const advance = await fetchIndiaAlerts(place, {
    now: NOW,
    request: request(feed(), { [link(1)]: later(cap()) }),
  });
  assert.deepEqual(advance.alerts, []);
  assert.equal(advance.upcomingDocuments, 1);
  assert.equal(advance.upcomingAt, Date.UTC(2026, 10, 1, 6));
  assert.match(
    advance.coverage,
    /1 regional bulletin\(s\) take effect later and are not listed as current warnings yet; the earliest takes effect at 2026-11-01T06:00:00\.000Z\./,
  );
  const pending = await fetchIndiaAlerts(place, {
    now: NOW,
    request: request(feed([link(1), link(2)]), {
      [link(1)]: cap(),
      [link(2)]: later(cap(2, 'Update', 'IMD-fixture,fixture-1,2026-11-01T00:00:00Z')),
    }),
  });
  assert.deepEqual(
    pending.alerts.map((alert) => alert.id),
    ['sachet:fixture-1:0'],
  );
  assert.match(pending.coverage, /1 regional bulletin\(s\) take effect later/);
});

test('future feed dates, all failed details and arbitrary-host links cannot become available', async () => {
  await assert.rejects(
    fetchIndiaAlerts(place, {
      now: NOW,
      request: request(feed([], 'Mon, 02 Nov 2026 00:00:00 GMT')),
    }),
    /future/,
  );
  await assert.rejects(
    fetchIndiaAlerts(place, {
      now: NOW,
      request: request(feed(), { [link(1)]: new Error('upstream') }),
    }),
    /could not be verified/,
  );
  let calls = 0;
  await assert.rejects(
    fetchIndiaAlerts(place, {
      now: NOW,
      request: async () => {
        calls++;
        return { text: feed(['https://evil.example/secret']), fetchedAt: NOW };
      },
    }),
    /could not be verified/,
  );
  assert.equal(calls, 1);
});

test('partially failed details keep verified entries with an explicit missing-detail count', async () => {
  const result = await fetchIndiaAlerts(place, {
    now: NOW,
    request: request(feed([link(1), link(2)]), {
      [link(1)]: cap(),
      [link(2)]: new Error('network failed'),
    }),
  });
  assert.equal(result.alerts.length, 1);
  assert.match(result.coverage, /1 warning detail request/);
});

test('cancellation metadata removes referenced original from the regional result', async () => {
  const result = await fetchIndiaAlerts(place, {
    now: NOW,
    request: request(feed([link(1), link(2)]), {
      [link(1)]: cap(),
      [link(2)]: cap(2, 'Cancel', 'IMD-fixture,fixture-1,2026-11-01T00:00:00Z'),
    }),
  });
  assert.deepEqual(result.alerts, []);
  assert.equal(result.partial, true);
});

test('an Alert whose expiry precedes its issue time is counted as not verified; a Cancel like it still withdraws', async () => {
  // A mistyped date: the bulletin "expires" the day before it was issued.
  const ended = '<expires>2026-10-31T03:00:00Z</expires>';
  const mistyped = cap(2).replace('<expires>2026-11-01T03:00:00Z</expires>', ended);
  const listed = await fetchIndiaAlerts(place, {
    now: NOW,
    request: request(feed([link(1), link(2)]), { [link(1)]: cap(), [link(2)]: mistyped }),
  });
  assert.deepEqual(
    listed.alerts.map((alert) => alert.id),
    ['sachet:fixture-1:0'],
  );
  assert.match(listed.coverage, /1 warning detail request\(s\) could not be verified/);
  // Alone, it is an error, never an available feed with nothing in it.
  await assert.rejects(
    fetchIndiaAlerts(place, {
      now: NOW,
      request: request(feed([link(2)]), { [link(2)]: mistyped }),
    }),
    /could not be verified/,
  );
  // The same interval in a Cancel that carries information is valid CAP and ends the warning.
  const cancel = mistyped
    .replace('<msgType>Alert</msgType>', '<msgType>Cancel</msgType>')
    .replace(
      '<scope>Public</scope>',
      '<scope>Public</scope><references>IMD-fixture,fixture-1,2026-11-01T00:00:00Z</references>',
    );
  const withdrawn = await fetchIndiaAlerts(place, {
    now: NOW,
    request: request(feed([link(1), link(2)]), { [link(1)]: cap(), [link(2)]: cancel }),
  });
  assert.deepEqual(withdrawn.alerts, []);
  assert.doesNotMatch(withdrawn.coverage, /could not be verified/);
});

test('missing CAP expiry is not invented and omitted validity is explained', async () => {
  const result = await fetchIndiaAlerts(place, {
    now: NOW,
    request: request(feed(), {
      [link(1)]: cap().replace('<expires>2026-11-01T03:00:00Z</expires>', ''),
    }),
  });
  assert.deepEqual(result.alerts, []);
  assert.match(result.coverage, /no stated expiry/);
});

test('multiple English info blocks remain separate while duplicate translated copies are not repeated', async () => {
  const source = cap();
  const first = /<info>[\s\S]*<\/info>/.exec(source)![0];
  const second = first.replace('Raigad district', 'Another district');
  const translated = first.replace('en-IN', 'mr-IN');
  const result = await fetchIndiaAlerts(place, {
    now: NOW,
    request: request(feed(), { [link(1)]: source.replace(first, first + second + translated) }),
  });
  assert.equal(result.alerts.length, 2);
  assert.equal(new Set(result.alerts.map((a) => a.id)).size, 2);
  assert.deepEqual(
    result.alerts.map((a) => a.area),
    ['Raigad district of Maharashtra', 'Another district of Maharashtra'],
  );
});

test('India detail requests cap at ten with no more than four concurrent requests', async () => {
  let count = 0,
    simultaneous = 0,
    maxSimultaneous = 0;
  const result = await fetchIndiaAlerts(place, {
    now: NOW,
    request: async (url) => {
      if (url.includes('/rss/'))
        return { text: feed(Array.from({ length: 12 }, (_, i) => link(i + 1))), fetchedAt: NOW };
      count++;
      simultaneous++;
      maxSimultaneous = Math.max(simultaneous, maxSimultaneous);
      await new Promise((resolve) => setTimeout(resolve, 2));
      simultaneous--;
      return { text: cap(Number(new URL(url).searchParams.get('identifier'))), fetchedAt: NOW };
    },
  });
  assert.equal(count, 10);
  assert.equal(maxSimultaneous, 4);
  assert.equal(result.alerts.length, 10);
  assert.match(result.coverage, /Additional feed entries were not checked/);
});

test('a slow India detail does not block later details while request concurrency stays at four', async () => {
  const urls = Array.from({ length: 8 }, (_, index) => link(index + 1));
  const started: string[] = [];
  let releaseFirst!: () => void, finishedRest!: () => void;
  const first = new Promise<void>((resolve) => (releaseFirst = resolve));
  const rest = new Promise<void>((resolve) => (finishedRest = resolve));
  let active = 0,
    peak = 0,
    completed = 0;
  const pending = fetchIndiaAlerts(place, {
    now: NOW,
    request: async (url) => {
      if (url.includes('/rss/')) return { text: feed(urls), fetchedAt: NOW };
      started.push(url);
      active++;
      peak = Math.max(peak, active);
      if (url === link(1)) await first;
      else await Promise.resolve();
      active--;
      if (url !== link(1) && ++completed === 7) finishedRest();
      return { text: cap(Number(new URL(url).searchParams.get('identifier'))), fetchedAt: NOW };
    },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      rest,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Later details were blocked by the first')),
          500,
        );
      }),
    ]);
    assert.deepEqual(started, urls);
    assert.equal(peak, 4);
  } finally {
    clearTimeout(timeout);
    releaseFirst();
    await pending;
  }
  assert.equal((await pending).alerts.length, 8);
});

test('India cancellation stops workers before starting queued details', async () => {
  const controller = new AbortController();
  const urls = Array.from({ length: 8 }, (_, index) => link(index + 1));
  const started: string[] = [];
  let firstFourStarted!: () => void;
  const ready = new Promise<void>((resolve) => (firstFourStarted = resolve));
  const pending = fetchIndiaAlerts(place, {
    now: NOW,
    signal: controller.signal,
    request: async (url, options) => {
      if (url.includes('/rss/')) return { text: feed(urls), fetchedAt: NOW };
      started.push(url);
      if (started.length === 4) firstFourStarted();
      return new Promise((_, reject) => {
        options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), {
          once: true,
        });
      });
    },
  });
  await ready;
  controller.abort(new Error('Source deadline reached'));
  await assert.rejects(pending, /Source deadline reached/);
  assert.deepEqual(started, urls.slice(0, 4));
});

test('caller cancellation propagates instead of returning an available empty list', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(
    fetchIndiaAlerts(place, { now: NOW, signal: controller.signal, request: request() }),
    /cancelled/,
  );
});

test('feed entries are read newest first whatever their feed order; unknown order is disclosed', async () => {
  // Twelve entries listed oldest first: the ten most recently published are the ones read.
  const items = (published: boolean) =>
    `<rss><channel>${Array.from(
      { length: 12 },
      (_, i) =>
        `<item><link>${link(i + 1)}</link>${published ? `<pubDate>${new Date(NOW - (12 - i) * 60_000).toUTCString()}</pubDate>` : ''}</item>`,
    ).join('')}</channel></rss>`;
  const requested: number[] = [];
  const reader = (rss: string) => async (url: string) => {
    if (url.includes('/rss/')) return { text: rss, fetchedAt: NOW };
    const id = Number(new URL(url).searchParams.get('identifier'));
    requested.push(id);
    return { text: cap(id), fetchedAt: NOW };
  };
  const ordered = await fetchIndiaAlerts(place, { now: NOW, request: reader(items(true)) });
  assert.deepEqual(requested, [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  assert.equal(ordered.feedUpdatedAt, NOW - 60_000);
  assert.match(ordered.coverage, /Additional feed entries were not checked/);
  assert.doesNotMatch(ordered.coverage, /may not be the most recent/);
  // Without usable publication times the feed order is kept, and the result says so.
  requested.length = 0;
  const unknown = await fetchIndiaAlerts(place, { now: NOW, request: reader(items(false)) });
  assert.deepEqual(requested, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.match(
    unknown.coverage,
    /Some feed entries have no usable publication time, so the entries checked may not be the most recent\./,
  );
});

test('the newest entries of a feed longer than 100 entries are read, wherever the feed lists them', async () => {
  // 101 entries, oldest first. The first hundred were published three days ago and have expired;
  // only the last one, published five minutes ago, is a current warning.
  const published = (id: number) =>
    id === 101 ? NOW - 5 * 60_000 : NOW - 3 * 86_400_000 + id * 60_000;
  const rss = `<rss><channel>${Array.from(
    { length: 101 },
    (_, i) =>
      `<item><link>${link(i + 1)}</link><pubDate>${new Date(published(i + 1)).toUTCString()}</pubDate></item>`,
  ).join('')}</channel></rss>`;
  const requested: number[] = [];
  const result = await fetchIndiaAlerts(place, {
    now: NOW,
    request: async (url) => {
      if (url.includes('/rss/')) return { text: rss, fetchedAt: NOW };
      const id = Number(new URL(url).searchParams.get('identifier'));
      requested.push(id);
      return {
        text: id === 101 ? cap(id) : cap(id).replaceAll('2026-11-01', '2026-10-29'),
        fetchedAt: NOW,
      };
    },
  });
  assert.deepEqual(requested, [101, 100, 99, 98, 97, 96, 95, 94, 93, 92]);
  assert.deepEqual(
    result.alerts.map((alert) => alert.id),
    ['sachet:fixture-101:0'],
  );
  // The feed's latest bulletin time comes from every entry, so a current feed is not called old.
  assert.equal(result.feedUpdatedAt, published(101));
  assert.doesNotMatch(result.coverage, /Current regional coverage is unverified/);
  assert.match(result.coverage, /Additional feed entries were not checked/);
  assert.doesNotMatch(result.coverage, /may not be the most recent/);
});

test('an oldest-first feed whose times have no zone is still read newest first', async () => {
  // Twelve entries, oldest first, with Indian clock times that name no zone (NOW is 06:30 there).
  const local = (minutesAgo: number) =>
    new Date(NOW + 330 * 60_000 - minutesAgo * 60_000).toUTCString().replace(' GMT', '');
  const items = (stamp: (index: number) => string) =>
    `<rss><channel>${Array.from(
      { length: 12 },
      (_, i) => `<item><link>${link(i + 1)}</link><pubDate>${stamp(i)}</pubDate></item>`,
    ).join('')}</channel></rss>`;
  const requested: number[] = [];
  const reader = (rss: string) => async (url: string) => {
    if (url.includes('/rss/')) return { text: rss, fetchedAt: NOW };
    const id = Number(new URL(url).searchParams.get('identifier'));
    requested.push(id);
    return { text: cap(id), fetchedAt: NOW };
  };
  const zoneless = await fetchIndiaAlerts(place, {
    now: NOW,
    request: reader(items((i) => local(12 - i))),
  });
  // The current bulletins (11 and 12) are among those read; the two oldest are left out.
  assert.deepEqual(requested, [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  assert.equal(zoneless.alerts.length, 10);
  // The times order the entries but are never used as instants.
  assert.equal(zoneless.feedUpdatedAt, null);
  assert.match(zoneless.coverage, /have no time zone, so the latest bulletin time is unknown/);
  assert.doesNotMatch(zoneless.coverage, /may not be the most recent/);
  // A feed that mixes times with and without a zone cannot be ordered reliably: say so.
  requested.length = 0;
  const mixed = await fetchIndiaAlerts(place, {
    now: NOW,
    request: reader(
      items((i) => (i % 2 ? local(12 - i) : new Date(NOW - (12 - i) * 60_000).toUTCString())),
    ),
  });
  assert.equal(requested.length, 10);
  assert.match(mixed.coverage, /they only set the order in which entries are read/);
  assert.match(mixed.coverage, /so the entries checked may not be the most recent/);
});

test('the most severe bulletins are listed first and kept when there are more texts than the bound', async () => {
  const bulletin = (id: number, severity: string, sent: string, blocks: number) =>
    `<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>fixture-${id}</identifier><sender>IMD-fixture</sender><sent>${sent}</sent><status>Actual</status><msgType>Alert</msgType><scope>Public</scope>${`<info><language>en-IN</language><category>Met</category><event>${severity} fixture</event><urgency>Expected</urgency><severity>${severity}</severity><certainty>Likely</certainty><effective>${sent}</effective><expires>2026-11-01T06:00:00Z</expires><area><areaDesc>District ${id}</areaDesc></area></info>`.repeat(blocks)}</alert>`;
  const check = (blocks: number, minor: number) =>
    fetchIndiaAlerts(place, {
      now: NOW,
      request: request(
        feed(Array.from({ length: minor + 1 }, (_, i) => link(i + 1))),
        Object.fromEntries(
          Array.from({ length: minor + 1 }, (_, i) => [
            link(i + 1),
            i === 0
              ? // An Extreme cyclone bulletin issued three hours before newer minor ones.
                bulletin(1, 'Extreme', '2026-10-31T22:00:00Z', blocks)
              : bulletin(
                  i + 1,
                  'Minor',
                  `2026-11-01T00:${String(i * 5).padStart(2, '0')}:00Z`,
                  blocks,
                ),
          ]),
        ),
      ),
    });
  // Twenty texts for a bound of ten: both Extreme texts are kept, ahead of the newer Minor ones.
  const bounded = await check(2, 9);
  assert.deepEqual(
    bounded.alerts.map((alert) => alert.severity),
    ['Extreme', 'Extreme', ...Array(8).fill('Minor')],
  );
  assert.match(bounded.coverage, /10 additional warning text\(s\) were not included/);
  // With one text per bulletin nothing is cut, and the Extreme warning leads the list.
  const listed = await check(1, 5);
  assert.deepEqual(
    listed.alerts.map((alert) => alert.severity),
    ['Extreme', ...Array(5).fill('Minor')],
  );
  // Equal severities keep the newest first.
  assert.deepEqual(
    listed.alerts.slice(1).map((alert) => alert.id),
    [6, 5, 4, 3, 2].map((id) => `sachet:fixture-${id}:0`),
  );
});

test('a current bulletin without an <area> is listed, with its missing area stated', async () => {
  const withoutArea = (raw: string) => raw.replace(/<area>.*?<\/area>/, '');
  const result = await fetchIndiaAlerts(place, {
    now: NOW,
    request: request(feed(), { [link(1)]: withoutArea(cap()) }),
  });
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].severity, 'Severe');
  assert.equal(result.alerts[0].area, 'Affected area not stated; read the official bulletin.');
  // An English block without an area is still the one listed beside a regional-language copy.
  const english = /<info>[\s\S]*<\/info>/.exec(cap())![0];
  const mixed = await fetchIndiaAlerts(place, {
    now: NOW,
    request: request(feed(), {
      [link(1)]: cap().replace(english, withoutArea(english) + english.replace('en-IN', 'ta-IN')),
    }),
  });
  assert.deepEqual(
    mixed.alerts.map((alert) => alert.area),
    ['Affected area not stated; read the official bulletin.'],
  );
});

test('a long list of affected areas is shortened with a count, never cut off silently', async () => {
  const areas = Array.from({ length: 100 }, (_, i) =>
    i === 99 ? 'Howrah district' : `Block ${i + 1}, Purba Medinipur district, West Bengal`,
  );
  const source = cap().replace(
    '<area><areaDesc>Raigad district of Maharashtra</areaDesc></area>',
    areas.map((name) => `<area><areaDesc>${name}</areaDesc></area>`).join(''),
  );
  const result = await fetchIndiaAlerts(
    { ...place, name: 'Howrah', admin: 'West Bengal' },
    { now: NOW, request: request(feed(), { [link(1)]: source }) },
  );
  const area = result.alerts[0].area;
  assert.ok(area.length <= 4000, String(area.length));
  assert.match(area, /^Block 1, Purba Medinipur district, West Bengal; Block 2, /);
  assert.match(
    area,
    /; Block \d+, Purba Medinipur district, West Bengal … \[\d+ more area\(s\) named in the official bulletin\]$/,
  );
});

test('the check deadline keeps the bulletins verified in time; the caller can still cancel', async () => {
  const links = Array.from({ length: 8 }, (_, i) => link(i + 1));
  // Details 5 to 8 never answer and ignore cancellation.
  const slow = async (url: string) => {
    if (url.includes('/rss/')) return { text: feed(links), fetchedAt: NOW };
    const id = Number(new URL(url).searchParams.get('identifier'));
    if (id > 4) return new Promise<never>(() => {});
    return { text: cap(id), fetchedAt: NOW };
  };
  const result = await fetchIndiaAlerts(place, { now: NOW, request: slow, deadlineMs: 50 });
  assert.equal(result.status, 'available');
  assert.deepEqual(
    result.alerts.map((alert) => alert.id).sort(),
    [1, 2, 3, 4].map((id) => `sachet:fixture-${id}:0`),
  );
  assert.match(result.coverage, /4 warning detail request\(s\) could not be verified/);
  // The caller's cancellation still ends the check without a partial result.
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('Location changed')), 10);
  await assert.rejects(
    fetchIndiaAlerts(place, {
      now: NOW,
      request: slow,
      deadlineMs: 5_000,
      signal: controller.signal,
    }),
    /Location changed/,
  );
  // A feed that does not arrive by the deadline fails the check; it is never an empty result.
  await assert.rejects(
    fetchIndiaAlerts(place, {
      now: NOW,
      request: () => new Promise<never>(() => {}),
      deadlineMs: 20,
    }),
    /timed out/,
  );
});

test('a stalled detail holds one slot until the check deadline; the other bulletins are verified', async () => {
  const links = Array.from({ length: 8 }, (_, i) => link(i + 1));
  const started: number[] = [];
  // Only the listed details answer; the others never do and ignore cancellation.
  const reader = (answering: number[]) => async (url: string) => {
    if (url.includes('/rss/')) return { text: feed(links), fetchedAt: NOW };
    const id = Number(new URL(url).searchParams.get('identifier'));
    started.push(id);
    if (!answering.includes(id)) return new Promise<never>(() => {});
    return { text: cap(id), fetchedAt: NOW };
  };
  const stalled = await fetchIndiaAlerts(place, {
    now: NOW,
    request: reader([2, 3, 4, 5, 6, 7, 8]),
    deadlineMs: 100,
  });
  assert.deepEqual(started, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(
    stalled.alerts.map((alert) => alert.id).sort(),
    [2, 3, 4, 5, 6, 7, 8].map((id) => `sachet:fixture-${id}:0`),
  );
  assert.match(stalled.coverage, /1 warning detail request\(s\) could not be verified/);
  // Once the deadline passes no queued detail is started, and the one verified bulletin is kept.
  started.length = 0;
  const queued = await fetchIndiaAlerts(place, { now: NOW, request: reader([1]), deadlineMs: 100 });
  assert.deepEqual(started, [1, 2, 3, 4, 5]);
  assert.deepEqual(
    queued.alerts.map((alert) => alert.id),
    ['sachet:fixture-1:0'],
  );
  assert.match(queued.coverage, /7 warning detail request\(s\) could not be verified/);
});
