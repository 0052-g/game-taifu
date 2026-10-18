import dataset from './japan-mesh.json';
import { CITY_LOCATIONS } from './city-locations';
import { toMapPoint, fromMapPoint } from './map';
import type { Point } from '../types';

export interface MeshCell {
  id: number;
  ix: number;
  iy: number;
  position: Point;
  population: number;
  areaKm2: number;
  elevationM: number | null;
  maxElevationM: number | null;
  reliefM: number | null;
  landFraction: number;
  demCoverage: number;
  /** Nearest orientation label, not an official city boundary. */
  reportingCityId: string;
  elevationQuality: 'available' | 'zero-ambiguous' | 'missing' | 'coast-outside';
  readonly coastMask: Uint8Array;
  readonly hasCoastSamples: boolean;
}

type DataRow = [number, number, number | null, number | null, number | null, number, number, string, number];
export const MESH_GRID = dataset.grid;
export const POPULATION_YEAR = dataset.populationYear;
export const TOTAL_POPULATION = dataset.totalPopulation;

const byGridId = new Int32Array(MESH_GRID.width * MESH_GRID.height).fill(-1);
const labelPoints = CITY_LOCATIONS.map(city => ({ id: city.id, point: toMapPoint(city.longitude, city.latitude) }));
const citySummaries = new Map<string, { population: number; cellCount: number }>();
for (const label of CITY_LOCATIONS) citySummaries.set(label.id, { population: 0, cellCount: 0 });
const qualities = ['available', 'zero-ambiguous', 'missing', 'coast-outside'] as const;
const rad = Math.PI / 180;
const earthRadiusKm = 6371.0088;

function cellAreaKm2(iy: number): number {
  const south = MESH_GRID.south + iy * MESH_GRID.latStep;
  const north = south + MESH_GRID.latStep;
  return earthRadiusKm ** 2 * MESH_GRID.lonStep * rad * (Math.sin(north * rad) - Math.sin(south * rad));
}

const cells: MeshCell[] = [];
let observedPopulation = 0;
for (const row of dataset.cells as DataRow[]) {
  const [id, population, elevationM, maxElevationM, reliefM, landPermille, coveragePermille, encodedMask, quality] = row;
  if (id < 0 || id >= byGridId.length || byGridId[id] !== -1 || population < 0) throw new Error('地理メッシュデータの整合性エラー');
  const ix = id % MESH_GRID.width;
  const iy = Math.floor(id / MESH_GRID.width);
  const position = toMapPoint(MESH_GRID.west + (ix + 0.5) * MESH_GRID.lonStep, MESH_GRID.south + (iy + 0.5) * MESH_GRID.latStep);
  let reportingCityId: string = labelPoints[0].id;
  let nearestDistance = Infinity;
  for (const label of labelPoints) {
    const squared = (position.x - label.point.x) ** 2 + (position.y - label.point.y) ** 2;
    if (squared < nearestDistance) { nearestDistance = squared; reportingCityId = label.id; }
  }
  const bytes = atob(encodedMask);
  const coastMask = Uint8Array.from(bytes, char => char.charCodeAt(0));
  if (coastMask.length !== MESH_GRID.maskSize * MESH_GRID.maskSize / 8) throw new Error('海岸線マスクの整合性エラー');
  const cell: MeshCell = {
    id, ix, iy, position, population, areaKm2: cellAreaKm2(iy),
    elevationM, maxElevationM, reliefM,
    landFraction: landPermille / 1000, demCoverage: coveragePermille / 1000,
    reportingCityId, elevationQuality: qualities[quality] ?? 'missing', coastMask,
    hasCoastSamples: coastMask.some(byte => byte !== 0),
  };
  byGridId[id] = cells.length;
  cells.push(cell);
  observedPopulation += population;
  if (population > 0) {
    const summary = citySummaries.get(reportingCityId)!;
    summary.population += population;
    summary.cellCount++;
  }
}
if (observedPopulation !== TOTAL_POPULATION) throw new Error('人口メッシュの全国合計が一致しません');

export const MESH_CELLS: readonly MeshCell[] = cells;
export const POPULATION_CELLS: readonly MeshCell[] = cells.filter(cell => cell.population > 0);

export function cityPopulationSummary(cityId: string): { population: number; cellCount: number } {
  return citySummaries.get(cityId) ?? { population: 0, cellCount: 0 };
}

export function meshAt(point: Point): MeshCell | null {
  const { longitude, latitude } = fromMapPoint(point);
  const ix = Math.floor((longitude - MESH_GRID.west) / MESH_GRID.lonStep + 1e-9);
  const iy = Math.floor((latitude - MESH_GRID.south) / MESH_GRID.latStep + 1e-9);
  if (ix < 0 || ix >= MESH_GRID.width || iy < 0 || iy >= MESH_GRID.height) return null;
  return cells[byGridId[iy * MESH_GRID.width + ix]] ?? null;
}

/** Subcell coast samples distinguish real low coastal land from water at 0 m. */
export function isLandAt(point: Point): boolean {
  const cell = meshAt(point);
  if (!cell) return false;
  const { longitude, latitude } = fromMapPoint(point);
  const x = Math.max(0, Math.min(MESH_GRID.maskSize - 1, Math.floor(((longitude - MESH_GRID.west) / MESH_GRID.lonStep - cell.ix) * MESH_GRID.maskSize)));
  const y = Math.max(0, Math.min(MESH_GRID.maskSize - 1, Math.floor(((latitude - MESH_GRID.south) / MESH_GRID.latStep - cell.iy) * MESH_GRID.maskSize)));
  const bit = y * MESH_GRID.maskSize + x;
  if (cell.coastMask[bit >> 3] & (1 << (bit & 7))) return true;
  // Tiny inhabited islands can be generalized out of the 1:10m coastline.
  // Their census population is retained; classify only these unresolved cells as land.
  return !cell.hasCoastSamples && cell.population > 0;
}

export function meshCellBounds(cell: MeshCell): { x: number; y: number; width: number; height: number } {
  const topLeft = toMapPoint(MESH_GRID.west + cell.ix * MESH_GRID.lonStep, MESH_GRID.south + (cell.iy + 1) * MESH_GRID.latStep);
  const bottomRight = toMapPoint(MESH_GRID.west + (cell.ix + 1) * MESH_GRID.lonStep, MESH_GRID.south + cell.iy * MESH_GRID.latStep);
  return { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y };
}

/** Local grid lookup: cost depends on the wind footprint, not the national row count. */
export function populationCellsNear(point: Point, radius: number): MeshCell[] {
  if (radius < 0 || !Number.isFinite(radius)) return [];
  const westSouth = fromMapPoint({ x: point.x - radius, y: point.y + radius });
  const eastNorth = fromMapPoint({ x: point.x + radius, y: point.y - radius });
  const minX = Math.max(0, Math.floor((westSouth.longitude - MESH_GRID.west) / MESH_GRID.lonStep));
  const maxX = Math.min(MESH_GRID.width - 1, Math.floor((eastNorth.longitude - MESH_GRID.west) / MESH_GRID.lonStep));
  const minY = Math.max(0, Math.floor((westSouth.latitude - MESH_GRID.south) / MESH_GRID.latStep));
  const maxY = Math.min(MESH_GRID.height - 1, Math.floor((eastNorth.latitude - MESH_GRID.south) / MESH_GRID.latStep));
  const found: MeshCell[] = [];
  const radiusSquared = radius * radius;
  for (let iy = minY; iy <= maxY; iy++) for (let ix = minX; ix <= maxX; ix++) {
    const cell = cells[byGridId[iy * MESH_GRID.width + ix]];
    if (cell?.population && (cell.position.x - point.x) ** 2 + (cell.position.y - point.y) ** 2 <= radiusSquared) found.push(cell);
  }
  return found;
}
