import type { Place } from './types.ts';

export interface WarningSourceLink {
  label: string;
  url: string;
}

/** Direct authority links remain usable when an integrated feed fails or is incomplete. */
export function localWarningSources(place: Place): WarningSourceLink[] {
  const country = place.countryCode.toUpperCase();
  if (country === 'IN') {
    const regions = [
      ['West Bengal', 'IMD Kolkata / West Bengal', 'kolkata'],
      ['Maharashtra', 'IMD Mumbai / Maharashtra', 'mumbai'],
      ['Odisha', 'IMD Odisha', 'bhubaneswar'],
      ['Tamil Nadu', 'IMD Chennai / Tamil Nadu', 'chennai'],
    ];
    const selected = regions.find(([region]) => region === place.admin);
    if (!selected) return [{ label: 'IMD national warnings', url: 'https://mausam.imd.gov.in/' }];
    return [selected, ...regions.filter((region) => region !== selected)].map(
      ([, label, slug]) => ({
        label,
        url: `https://mausam.imd.gov.in/${slug}/`,
      }),
    );
  }
  if (country === 'PH')
    return [
      ...(place.admin === 'National Capital Region' || place.name === 'Manila'
        ? [
            {
              label: 'PAGASA Metro Manila / NCR',
              url: 'https://pagasa.dost.gov.ph/regional-forecast/ncrprsd',
            },
          ]
        : []),
      { label: 'PAGASA national warnings', url: 'https://pagasa.dost.gov.ph/' },
    ];
  if (country === 'ID')
    return [
      ...(place.name === 'Jakarta' || place.admin === 'Jakarta Special Capital Region'
        ? [
            {
              label: 'BMKG Jakarta / Jabodetabek',
              url: 'https://www.bmkg.go.id/peringatan-dini/curah-hujan/nowcasting/31',
            },
          ]
        : []),
      { label: 'BMKG national warnings', url: 'https://www.bmkg.go.id/peringatan-dini' },
    ];
  if (country === 'US' && place.name === 'San Francisco')
    return [{ label: 'NWS San Francisco Bay Area', url: 'https://www.weather.gov/mtr/' }];
  return [];
}

export function warningSourceFallback(place: Place): string {
  const local = localWarningSources(place)[0];
  if (local) return local.url;
  return ['US', 'PR', 'VI', 'GU', 'AS', 'MP'].includes(place.countryCode.toUpperCase())
    ? 'https://www.weather.gov/'
    : place.countryCode.toUpperCase() === 'IN'
      ? 'https://mausam.imd.gov.in/'
      : 'https://severeweather.wmo.int/';
}
