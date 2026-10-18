import { CITY_RADIUS, SIMULATION_CONFIG } from '../config';
import { CITY_LOCATIONS } from './city-locations';
import { toMapPoint } from './map';
import { cityPopulationSummary } from './mesh';
import type { City } from '../types';

/** City labels report nearby mesh groups; they do not define scoring or municipal boundaries. */
export const CITIES: City[] = CITY_LOCATIONS.map(city => ({
  id: city.id,
  name: city.name,
  position: toMapPoint(city.longitude, city.latitude),
  weight: cityPopulationSummary(city.id).population * SIMULATION_CONFIG.meshAssetPointsPerPerson,
  radius: CITY_RADIUS,
}));
