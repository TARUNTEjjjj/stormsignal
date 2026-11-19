/**
 * Synthetic IMD district-nowcast feeds for the Worker CPU harness (docs/deployment.md). They use
 * the field order, namespace, CDATA and "+5:30" timezone spelling of the public item observed on
 * 1 November 2026 (tests/kolkata-alerts.test.ts), but every district name, identifier and text is
 * generated: no provider document is copied and no provider is contacted.
 */
export const FEED_MAX_ENTRIES = 1000;
export const FEED_MAX_BYTES = 1_000_000;

export interface FixtureSpec {
  /** Number of <item> entries, including the one Kolkata entry. */
  entries: number;
  /** Total UTF-8 size to pad up to; omitted keeps each entry near the observed 610-640 bytes. */
  targetBytes?: number;
  /** Clock used for the issue/onset/expiry times, so the Kolkata bulletin is current. */
  now: number;
}

const ist = (time: number) => new Date(time + 330 * 60_000).toISOString().slice(0, 19) + '+5:30';
const DESCRIPTION =
  'Moderate rain: 5-15 mm/hr ,\nModerate Thunderstorms with maximum surface wind speed between 41 - 61 kmph (In gusts) ,';

function entry(district: string, index: number, now: number, description: string): string {
  return `<item xmlns:dc='ns:1'><title>${district}</title><guid>${index.toString(16).padStart(32, '0')}</guid><link>https://mausam.imd.gov.in/imd_latest/contents/districtwisewarnings.php</link><sent>${ist(now - 60_000)}</sent><sender>nowcast@example.invalid</sender><pubDate>Sat, 31 Oct 2026 17:36:52 </pubDate><SenderName>nowcast@example.invalid</SenderName><Onset>${ist(now - 120_000)}</Onset><Expires>${ist(now + 3_600_000)}</Expires><description><![CDATA[${description}]]></description><category>NOWCAST</category></item>`;
}
const wrap = (items: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>IMD WARNING </title><description>IMD RSS</description><language>en</language>${items}</channel></rss>`;
const utf8 = (text: string) => new TextEncoder().encode(text).byteLength;

/**
 * A feed with `entries` items. Kolkata is the last entry, so the parser walks every other entry
 * before it reaches the one it needs (the worst position). With `targetBytes`, each description is
 * padded with plain ASCII text so the document is as close to that size as whole characters allow,
 * never above it.
 */
export function imdFeed({ entries, targetBytes, now }: FixtureSpec): string {
  if (!Number.isInteger(entries) || entries < 1 || entries > FEED_MAX_ENTRIES)
    throw new Error(`A fixture needs 1-${FEED_MAX_ENTRIES} entries.`);
  const build = (pad: number, extra: number) =>
    wrap(
      Array.from({ length: entries }, (_, index) => {
        const last = index === entries - 1;
        const filler = 'x'.repeat(pad + (index < extra ? 1 : 0));
        const text =
          targetBytes === undefined ? DESCRIPTION : `${DESCRIPTION} Synthetic padding ${filler}`;
        return entry(last ? 'KOLKATA' : `SYNTHETIC DISTRICT ${index + 1}`, index + 1, now, text);
      }).join(''),
    );
  const plain = build(0, 0);
  if (targetBytes === undefined) return plain;
  // Here `plain` already carries each entry's " Synthetic padding " label; add filler only.
  const spare = targetBytes - utf8(plain);
  if (spare < 0) throw new Error('Target size is smaller than the unpadded fixture.');
  const feed = build(Math.floor(spare / entries), spare % entries);
  if (utf8(feed) !== targetBytes) throw new Error('Fixture padding did not reach its target.');
  return feed;
}

/** The fixtures every harness run measures, from a short day to both parser bounds. */
export function standardFixtures(now: number): Record<string, string> {
  return {
    'short (20 entries)': imdFeed({ entries: 20, now }),
    'observed-size near-bound (1,000 entries)': imdFeed({ entries: FEED_MAX_ENTRIES, now }),
    'byte near-bound (1,000 entries, 1 MB)': imdFeed({
      entries: FEED_MAX_ENTRIES,
      targetBytes: FEED_MAX_BYTES,
      now,
    }),
  };
}
