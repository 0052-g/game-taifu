export interface Point {
  x: number;
  y: number;
}

export type Terrain = 'ocean' | 'land' | 'mountain';

export interface City {
  id: string;
  name: string;
  position: Point;
  /** Fictional asset value; replace the data provider to use real statistics. */
  weight: number;
  radius: number;
}

export interface Landmass {
  id: string;
  name: string;
  points: Point[];
}

export interface MountainZone {
  id: string;
  points: Point[];
}

export type EndReason = 'route-complete' | 'dissipated' | 'extratropical' | 'winter';

export interface CityDamage {
  remaining: number;
  damage: number;
  /** Historical maximum local exposure, from 0 to 1. */
  peakExposure: number;
}

export interface SimulationEvent {
  id: number;
  kind: 'city' | 'terrain' | 'warning' | 'season' | 'end';
  text: string;
  position: Point;
  score?: number;
}

export interface SimulationState {
  route: Point[];
  position: Point;
  strength: number;
  stability: number;
  elapsedDays: number;
  elapsedSeconds: number;
  score: number;
  cityDamage: Record<string, CityDamage>;
  traveledDistance: number;
  maxStrength: number;
  terrain: Terrain;
  phase: 'running' | 'finished';
  endReason: EndReason | null;
  events: SimulationEvent[];
  affectedCities: number;
  /** Internal deterministic integration state, also useful for route rendering. */
  routeSegment: number;
  segmentProgress: number;
  accumulator: number;
  nextEventId: number;
  lastSeason: number;
}
