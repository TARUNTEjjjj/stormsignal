import type { AlertResult, AlertSourceCheck, Place, WeatherAlert } from '../src/types';
import { fetchGlobalAlerts } from './global';
import { fetchIndiaAlerts } from './india';
import { fetchNationalAlerts } from './national';
import { fetchKolkataAlerts, supportsKolkata } from './kolkata';
import { warningSourceFallback } from '../src/warning-sources';

type SourceResult = AlertResult & { excludedCapKeys?: string[]; revokedCapKeys?: string[] };
type Loader = (place: Place, signal?: AbortSignal) => Promise<SourceResult>;
interface SourceSpec {
  id: string;
  name: string;
  url: string;
  load: Loader;
}

export function createLocalAlertAdapter(dependencies: {
  national: Loader;
  global: Loader;
  kolkata: Loader;
  india: Loader;
}) {
  return async (place: Place, signal?: AbortSignal): Promise<AlertResult> => {
    signal?.throwIfAborted();
    const kolkata = supportsKolkata(place);
    const country = place.countryCode.toUpperCase();
    if (!kolkata && country !== 'PH' && country !== 'ID')
      throw new Error('Direct local coverage is not configured for this place.');
    const authority = country === 'PH' ? 'PAGASA' : 'BMKG';
    const specs: SourceSpec[] = kolkata
      ? [
          {
            id: 'imd-kolkata',
            name: 'IMD Kolkata district nowcasts · direct',
            url: 'https://mausam.imd.gov.in/kolkataums/district_nowcast_kolums.php',
            load: dependencies.kolkata,
          },
          {
            id: 'sachet',
            name: 'NDMA SACHET · West Bengal regional feed',
            url: 'https://sachet.ndma.gov.in/',
            load: dependencies.india,
          },
        ]
      : [
          {
            id: 'national',
            name: `${authority} CAP feed · direct`,
            url: warningSourceFallback(place),
            load: dependencies.national,
          },
          {
            id: 'wmo',
            name: `${authority} via WMO SWIC · supplementary`,
            url: 'https://severeweather.wmo.int/',
            load: dependencies.global,
          },
        ];
    const results = await Promise.allSettled(specs.map((spec) => spec.load(place, signal)));
    signal?.throwIfAborted();
    const available: Array<{ spec: SourceSpec; result: SourceResult }> = [];
    const checks: AlertSourceCheck[] = results.map((item, index) => {
      const spec = specs[index];
      if (item.status === 'fulfilled') {
        const result = item.value;
        if (result.status === 'available') available.push({ spec, result });
        return {
          id: spec.id,
          name: spec.name,
          url: spec.url,
          status: result.status,
          fetchedAt: result.fetchedAt,
          feedUpdatedAt: result.feedUpdatedAt ?? null,
          coverage: result.coverage,
        };
      }
      return {
        id: spec.id,
        name: spec.name,
        url: spec.url,
        status: 'unavailable',
        fetchedAt: null,
        coverage:
          'This source could not be reached or validated. Its warnings may be missing; check the authority directly.',
      };
    });
    if (!available.length) throw new Error('Neither official warning source could be verified.');
    const primary = available.find(({ spec }) => spec.id === specs[0].id)?.result;
    const revoked = available.flatMap(({ result }) => result.revokedCapKeys ?? []);
    const alerts = new Map<string, WeatherAlert>();
    const content = new Set<string>();
    const now = Date.now();
    for (const { spec, result } of available) {
      for (const alert of result.alerts) {
        if (
          alert.expires <= now ||
          alert.effective > now ||
          revoked.some((key) => alert.id.startsWith(key))
        )
          continue;
        // A directly inspected document (including an expired, cancelled or nonmatching one)
        // takes precedence over an indexed copy, even when it has no displayed alert.
        if (spec.id === 'wmo' && primary?.excludedCapKeys?.some((key) => alert.id.startsWith(key)))
          continue;
        // Some BMKG documents regenerate their identifier while preserving the entire bulletin.
        // Only exact authority/text/area/validity matches collapse; never normalize arbitrary IDs.
        const fingerprint = JSON.stringify([
          alert.source,
          alert.event,
          alert.title,
          alert.sent,
          alert.effective,
          alert.expires,
          alert.area,
          alert.description,
          alert.instruction,
        ]);
        if (!alerts.has(alert.id) && !content.has(fingerprint)) {
          alerts.set(alert.id, alert);
          content.add(fingerprint);
        }
      }
    }
    const severity: Record<string, number> = {
      Extreme: 0,
      Severe: 1,
      Moderate: 2,
      Minor: 3,
      Unknown: 4,
    };
    const ordered = [...alerts.values()].sort(
      (a, b) => (severity[a.severity] ?? 4) - (severity[b.severity] ?? 4) || b.sent - a.sent,
    );
    const published = available
      .map(({ result }) => result.feedUpdatedAt)
      .filter((v): v is number => typeof v === 'number' && v <= now);
    const failed = checks.filter((check) => check.status !== 'available').length;
    return {
      status: 'available',
      alerts: ordered.slice(0, 30),
      fetchedAt: Math.min(...available.map(({ result }) => result.fetchedAt)),
      source: failed
        ? `${available[0].result.source} · other source unavailable`
        : kolkata
          ? 'IMD district nowcasts + NDMA SACHET'
          : `${authority} direct + WMO SWIC`,
      officialUrl: specs[0].url,
      scope: kolkata ? 'region' : 'point',
      scopeLabel: kolkata ? 'Kolkata district + West Bengal' : place.name,
      partial: true,
      feedUpdatedAt: published.length ? Math.max(...published) : null,
      checks,
      coverage:
        (kolkata
          ? 'Direct IMD district nowcasts are checked alongside West Bengal regional SACHET bulletins. Read each bulletin’s affected area; regional notices do not automatically apply to Kolkata.'
          : `Direct ${authority} bulletins are checked alongside WMO’s mapped copies. Only warnings whose original boundaries cover this point are matched by the direct feed.`) +
        ` Coverage remains incomplete. ${failed ? `${failed} of ${checks.length} sources could not be verified. ` : ''}Each feed contains a bounded selection of bulletins. An empty list is not an all-clear.` +
        (ordered.length > 30
          ? ' Additional bulletins were omitted from this bounded response.'
          : ''),
    };
  };
}

export const fetchLocalAlerts = createLocalAlertAdapter({
  national: fetchNationalAlerts,
  global: fetchGlobalAlerts,
  kolkata: fetchKolkataAlerts,
  india: (place, signal) => fetchIndiaAlerts(place, { signal }),
});
