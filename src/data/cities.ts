import { CITY_RADIUS, CITY_WEIGHTS } from '../config';
import { project } from '../geo';
import type { City } from '../types';

/**
 * Approximate city centers with fictional asset weights, not population data.
 * Replace this data adapter with a population/land-use source in a future version.
 * Radius is in map units and represents an area of assets around each city.
 */
const city = (id: keyof typeof CITY_WEIGHTS, name: string, longitude: number, latitude: number): City => ({
  id,
  name,
  position: project(longitude, latitude),
  weight: CITY_WEIGHTS[id],
  radius: CITY_RADIUS,
});

export const CITIES: City[] = [
  city('sapporo', '札幌', 141.35, 43.06),
  city('aomori', '青森', 140.74, 40.82),
  city('sendai', '仙台', 140.87, 38.27),
  city('niigata', '新潟', 139.02, 37.92),
  city('tokyo', '東京', 139.70, 35.69),
  city('nagoya', '名古屋', 136.91, 35.18),
  city('kanazawa', '金沢', 136.65, 36.56),
  city('osaka', '大阪', 135.50, 34.69),
  city('kobe', '神戸', 135.18, 34.69),
  city('hiroshima', '広島', 132.46, 34.39),
  city('takamatsu', '高松', 134.04, 34.34),
  city('fukuoka', '福岡', 130.40, 33.59),
  city('kumamoto', '熊本', 130.71, 32.80),
  city('kagoshima', '鹿児島', 130.56, 31.60),
  city('naha', '那覇', 127.68, 26.21),
];
