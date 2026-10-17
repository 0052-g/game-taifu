import { LANDMASSES, MOUNTAIN_ZONES, toMapPoint } from './data/map';
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

export function terrainAt(point: Point): Terrain {
  if (!LANDMASSES.some((land) => pointInPolygon(point, land.points))) return 'ocean';
  return MOUNTAIN_ZONES.some((zone) => pointInPolygon(point, zone.points))
    ? 'mountain' : 'land';
}
