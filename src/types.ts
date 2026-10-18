export interface Point {
  x: number;
  y: number;
}

export type Terrain = 'ocean' | 'land' | 'mountain';

export interface City {
  id: string;
  name: string;
  position: Point;
  /** Sum of census-mesh population score assigned to this display group. */
  weight: number;
  radius: number;
}

export interface Landmass {
  id: string;
  name: string;
  points: Point[];
  holes?: Point[][];
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
  /** A visit ends only after clearing its influence radius plus the configured margin. */
  activeVisit: boolean;
  visitPeakExposure: number;
  visitStartingRemaining: number;
  visitCount: number;
  visitEventEmitted: boolean;
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
  /** Display-only aggregation by the nearest named city; groups are not municipal borders. */
  cityDamage: Record<string, CityDamage>;
  /** Canonical finite assets, allocated lazily only for population cells reached by the storm. */
  meshDamage: Record<number, CityDamage>;
  /** Changed assets since the single canvas renderer last consumed them. */
  meshDamageDirtyIds: Set<number>;
  activeMeshIds: Set<number>;
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
