import coastline from './coastline.json';
import type { Landmass, Point } from '../types';

export const MAP_WIDTH = 1000;
export const MAP_HEIGHT = 760;
export const MAP_BOUNDS = { west: 122, east: 148, south: 24, north: 47 } as const;

/** The game viewport; national mesh data also retains remote islands outside it. */
export function toMapPoint(longitude: number, latitude: number): Point {
  return {
    x: ((longitude - MAP_BOUNDS.west) / (MAP_BOUNDS.east - MAP_BOUNDS.west)) * MAP_WIDTH,
    y: ((MAP_BOUNDS.north - latitude) / (MAP_BOUNDS.north - MAP_BOUNDS.south)) * MAP_HEIGHT,
  };
}

export function fromMapPoint(point: Point): { longitude: number; latitude: number } {
  return {
    longitude: MAP_BOUNDS.west + point.x / MAP_WIDTH * (MAP_BOUNDS.east - MAP_BOUNDS.west),
    latitude: MAP_BOUNDS.north - point.y / MAP_HEIGHT * (MAP_BOUNDS.north - MAP_BOUNDS.south),
  };
}

/** Natural Earth 5.1.2, 1:10 million country geometry, public domain. */
export const LANDMASSES: Landmass[] = (coastline.coordinates as number[][][][]).map((rings, index) => ({
  id: `japan-${index}`,
  name: '日本列島',
  points: rings[0].map(([longitude, latitude]) => toMapPoint(longitude, latitude)),
  holes: rings.slice(1).map(ring => ring.map(([longitude, latitude]) => toMapPoint(longitude, latitude))),
}));

export const START_POINT: Point = toMapPoint(132, 28);
