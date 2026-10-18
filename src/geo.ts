import { toMapPoint } from './data/map';
import { isLandAt, meshAt } from './data/mesh';
import { SIMULATION_CONFIG } from './config';
import type { Point, Terrain } from './types';

export const project = toMapPoint;

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Ray casting, including boundary points so coastal contacts are consistent. */
export function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j];
    const b = polygon[i];
    const cross = (point.y - a.y) * (b.x - a.x) - (point.x - a.x) * (b.y - a.y);
    if (Math.abs(cross) < 1e-7 &&
      point.x >= Math.min(a.x, b.x) - 1e-7 &&
      point.x <= Math.max(a.x, b.x) + 1e-7 &&
      point.y >= Math.min(a.y, b.y) - 1e-7 &&
      point.y <= Math.max(a.y, b.y) + 1e-7) return true;
    if ((a.y > point.y) !== (b.y > point.y) &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Real coastal mask and aggregated GSI elevation; missing elevations stay unknown. */
export function terrainAt(point: Point): Terrain {
  if (!isLandAt(point)) return 'ocean';
  const cell = meshAt(point);
  if (!cell) return 'land';
  return (cell.elevationM !== null && cell.elevationM >= SIMULATION_CONFIG.terrainMountainElevationM)
    || (cell.reliefM !== null && cell.reliefM >= SIMULATION_CONFIG.terrainMountainReliefM)
    ? 'mountain' : 'land';
}
