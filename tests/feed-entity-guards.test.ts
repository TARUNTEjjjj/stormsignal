import assert from 'node:assert/strict';
import test from 'node:test';
import { createKolkataAlertAdapter } from '../server/kolkata';
import { createNationalAlertAdapter } from '../server/national';
import type { Place } from '../src/types';

// The feed parsers expand entities, so documents that declare any are refused before parsing.
// Each feed below is well-formed and otherwise accepted (see its control): without that guard, the
// entity's text would become part of an official bulletin.
const now = Date.now();

test('the IMD district feed refuses a document type that would put its own text in a bulletin', async () => {
  const ist = (time: number) => new Date(time + 330 * 60_000).toISOString().slice(0, 19) + '+5:30';
  const feed = (description: string, doctype = '') =>
    `<?xml version="1.0" encoding="UTF-8"?>${doctype}<rss version="2.0"><channel><title>IMD WARNING</title><item><title>KOLKATA</title><guid>fixture-1</guid><sent>${ist(now - 60_000)}</sent><Onset>${ist(now - 120_000)}</Onset><Expires>${ist(now + 3_600_000)}</Expires><category>NOWCAST</category><description>${description}</description></item></channel></rss>`;
  const kolkata: Place = {
    id: '1275004',
    name: 'Kolkata',
    country: 'India',
    countryCode: 'IN',
    admin: 'West Bengal',
    latitude: 22.56263,
    longitude: 88.36304,
  };
  const check = (raw: string) =>
    createKolkataAlertAdapter(async () => ({ text: raw, fetchedAt: now - 500 }))(kolkata);
  assert.equal((await check(feed('Moderate rain'))).alerts.length, 1);
  await assert.rejects(
    check(feed('&x;', '<!DOCTYPE rss [<!ENTITY x "Injected text, no warning">]>')),
    /entities and document types are not accepted/,
  );
});

test('the PAGASA Atom feed refuses a document type', async () => {
  const sent = new Date(now - 60_000).toISOString();
  const detail =
    'https://publicalert.pagasa.dost.gov.ph/output/gfa/00000000-0000-4000-8000-000000000001.cap';
  const feed = (updated: string, doctype = '') =>
    `${doctype}<feed xmlns="http://www.w3.org/2005/Atom"><updated>${updated}</updated><entry><updated>${sent}</updated><link type="application/cap+xml" href="${detail}"/></entry></feed>`;
  const cap = `<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>alert-1</identifier><sender>agency@example.gov</sender><sent>${sent}</sent><status>Actual</status><msgType>Alert</msgType><scope>Public</scope><info><language>en</language><category>Met</category><event>Flood</event><urgency>Immediate</urgency><severity>Severe</severity><certainty>Observed</certainty><effective>${sent}</effective><expires>${new Date(now + 3_600_000).toISOString()}</expires><senderName>Official agency</senderName><headline>Flood warning</headline><description>Original source description.</description><instruction>Official instructions.</instruction><area><areaDesc>Named district</areaDesc><polygon>14,120 14,122 16,122 16,120 14,120</polygon></area></info></alert>`;
  const manila: Place = {
    id: 'm',
    name: 'Manila',
    country: 'Philippines',
    countryCode: 'PH',
    latitude: 14.6042,
    longitude: 120.9822,
  };
  const check = (raw: string) =>
    createNationalAlertAdapter(
      async (url) => ({ text: url.endsWith('/feeds/') ? raw : cap, fetchedAt: now - 500 }),
      { now: () => now },
    )(manila);
  assert.equal((await check(feed(sent))).alerts.length, 1);
  await assert.rejects(
    check(feed('&x;', `<!DOCTYPE feed [<!ENTITY x "${sent}">]>`)),
    /Invalid official Atom feed/,
  );
});
