export interface Place {
  id: string;
  name: string;
  country: string;
  countryCode: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  admin?: string;
}
export interface Hour {
  time: number;
  temperature: number | null;
  apparent: number | null;
  precipitation: number | null;
  probability: number | null;
  wind: number | null;
  gust: number | null;
  humidity: number | null;
  code: number | null;
  uv: number | null;
}
export interface Day {
  time: number;
  high: number | null;
  low: number | null;
  rain: number | null;
  probability: number | null;
  gust: number | null;
  code: number | null;
  sunrise: number | null;
  sunset: number | null;
}
export interface Forecast {
  fetchedAt: number;
  timezone: string;
  current: Hour;
  hours: Hour[];
  days: Day[];
  source: string;
}
export interface ModelForecast {
  id: string;
  name: string;
  hours: Pick<Hour, 'time' | 'temperature' | 'precipitation' | 'wind'>[];
  fetchedAt: number;
}
export interface AirQuality {
  time: number;
  fetchedAt: number;
  usAqi: number | null;
  pm25: number | null;
  pm10: number | null;
  source: string;
}
export interface WeatherAlert {
  id: string;
  title: string;
  event: string;
  severity: string;
  area: string;
  sent: number;
  effective: number;
  expires: number;
  description: string;
  instruction: string;
  source: string;
  url: string;
  geometry: unknown | null;
}
export interface AlertResult {
  status: 'available' | 'unsupported';
  alerts: WeatherAlert[];
  fetchedAt: number;
  source: string;
  coverage: string;
  officialUrl: string;
  /** Feed scope is distinct from forecast coordinates. */
  scope?: 'point' | 'region' | 'country';
  scopeLabel?: string;
  partial?: boolean;
  feedUpdatedAt?: number | null;
  checks?: AlertSourceCheck[];
}
export interface AlertSourceCheck {
  id: string;
  name: string;
  url: string;
  status: 'available' | 'unavailable' | 'unsupported';
  fetchedAt: number | null;
  feedUpdatedAt?: number | null;
  coverage: string;
}
export interface Hazard {
  kind: 'rain' | 'wind' | 'heat' | 'cold' | 'uv' | 'thunder';
  level: 'elevated' | 'high';
  title: string;
  detail: string;
  time: number;
}
