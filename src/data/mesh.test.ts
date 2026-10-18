import { describe, expect, it } from 'vitest';
import { SIMULATION_CONFIG } from '../config';
import { CITIES } from './cities';
import { CITY_LOCATIONS } from './city-locations';
import { START_POINT, toMapPoint } from './map';
import {
  MESH_CELLS, MESH_GRID, POPULATION_CELLS, POPULATION_YEAR, TOTAL_POPULATION,
  cityPopulationSummary, meshAt, meshCellBounds, populationCellsNear,
} from './mesh';

describe('verified national census and DEM data', () => {
  it('retains the official 2020 census population exactly once across unique grid cells', () => {
    expect(POPULATION_YEAR).toBe(2020);
    // Statistics Bureau of Japan, 2020 census national total; not a model parameter.
    expect(TOTAL_POPULATION).toBe(126_146_099);
    expect(MESH_CELLS.reduce((sum, cell) => sum + cell.population, 0)).toBe(126_146_099);
    expect(new Set(MESH_CELLS.map(cell => cell.id)).size).toBe(MESH_CELLS.length);
    expect(POPULATION_CELLS).toHaveLength(13_799);
    expect(POPULATION_CELLS.every(cell => Number.isInteger(cell.population) && cell.population > 0)).toBe(true);
  });

  it('partitions all inhabited meshes into city reports without duplicating population or assets', () => {
    const reports = CITY_LOCATIONS.map(city => ({ id: city.id, ...cityPopulationSummary(city.id) }));
    expect(new Set(reports.map(report => report.id)).size).toBe(CITY_LOCATIONS.length);
    expect(reports.reduce((sum, report) => sum + report.population, 0)).toBe(126_146_099);
    expect(reports.reduce((sum, report) => sum + report.cellCount, 0)).toBe(POPULATION_CELLS.length);
    const assignedIds = new Set<number>();
    for (const report of reports) {
      const assigned = POPULATION_CELLS.filter(cell => cell.reportingCityId === report.id);
      expect(assigned.reduce((sum, cell) => sum + cell.population, 0)).toBe(report.population);
      expect(assigned).toHaveLength(report.cellCount);
      for (const cell of assigned) {
        expect(assignedIds.has(cell.id)).toBe(false);
        assignedIds.add(cell.id);
      }
    }
    expect(assignedIds.size).toBe(POPULATION_CELLS.length);
    expect(CITIES.reduce((sum, city) => sum + city.weight, 0)).toBeCloseTo(126_146_099 * SIMULATION_CONFIG.meshAssetPointsPerPerson, 6);
    expect(cityPopulationSummary('unknown-city')).toEqual({ population: 0, cellCount: 0 });
  });

  it('returns independently verified 5km census counts at Tokyo and Osaka', () => {
    // These are the enclosing grid counts, not municipal population estimates.
    expect(meshAt(toMapPoint(139.70, 35.69))?.population).toBe(343_444);
    expect(meshAt(toMapPoint(135.50, 34.69))?.population).toBe(440_462);
  });

  it('preserves the verified Fuji DEM aggregates and the distinction between mean and pixel maximum', () => {
    const fuji = meshAt(toMapPoint(138.7274, 35.3606));
    expect(fuji?.elevationQuality).toBe('available');
    expect(fuji?.elevationM).toBe(2625.8);
    expect(fuji?.maxElevationM).toBe(3705.5);
    expect(fuji?.reliefM).toBe(2217.5);
    expect(fuji!.maxElevationM!).toBeGreaterThan(fuji!.elevationM!);
    // 3705.5 is the maximum resampled source pixel, not the surveyed 3776m summit.
    expect(fuji!.maxElevationM!).toBeLessThan(3776);
  });

  it('keeps every coast mask complete and missing or ambiguous heights explicitly null', () => {
    expect(MESH_CELLS.filter(cell => cell.coastMask.length !== 32).map(cell => cell.id)).toEqual([]);
    const unknown = MESH_CELLS.filter(cell => cell.elevationQuality !== 'available');
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown.filter(cell => cell.elevationM !== null || cell.maxElevationM !== null || cell.reliefM !== null || cell.demCoverage !== 0).map(cell => cell.id)).toEqual([]);
    expect(MESH_CELLS.filter(cell => cell.elevationQuality === 'zero-ambiguous')).toHaveLength(93);
    expect(MESH_CELLS.filter(cell => cell.elevationQuality === 'missing')).toHaveLength(81);
    expect(MESH_CELLS.filter(cell => cell.elevationQuality === 'coast-outside').every(cell => cell.population > 0)).toBe(true);
  });
});

describe('geographic mesh query contracts', () => {
  it('finds the complete local population footprint, matching a national brute-force scan', () => {
    const radius = 22;
    for (const point of [toMapPoint(139.70, 35.69), toMapPoint(130.40, 33.59), START_POINT]) {
      const expected = POPULATION_CELLS
        .filter(cell => Math.hypot(cell.position.x - point.x, cell.position.y - point.y) <= radius)
        .map(cell => cell.id).sort((a, b) => a - b);
      const actual = populationCellsNear(point, radius).map(cell => cell.id).sort((a, b) => a - b);
      expect(actual).toEqual(expected);
      expect(new Set(actual).size).toBe(actual.length);
      expect(actual.length).toBeLessThan(POPULATION_CELLS.length / 20);
    }
  });

  it('round-trips every recorded cell centre and returns positive bounds containing that centre', () => {
    expect(MESH_CELLS.filter(cell => meshAt(cell.position)?.id !== cell.id).map(cell => cell.id)).toEqual([]);
    const invalidBounds = MESH_CELLS.filter(cell => {
      const bounds = meshCellBounds(cell);
      return bounds.width <= 0 || bounds.height <= 0
        || cell.position.x < bounds.x || cell.position.x > bounds.x + bounds.width
        || cell.position.y < bounds.y || cell.position.y > bounds.y + bounds.height;
    });
    expect(invalidBounds.map(cell => cell.id)).toEqual([]);
  });

  it('uses west and south inclusive grid boundaries and rejects points outside the national grid', () => {
    const tokyo = meshAt(toMapPoint(139.70, 35.69))!;
    const west = MESH_GRID.west + tokyo.ix * MESH_GRID.lonStep;
    const south = MESH_GRID.south + tokyo.iy * MESH_GRID.latStep;
    expect(meshAt(toMapPoint(west, south))?.id).toBe(tokyo.id);
    const westernNeighbour = MESH_CELLS.find(cell => cell.id === tokyo.id - 1);
    expect(meshAt(toMapPoint(west - 1e-7, south + MESH_GRID.latStep / 2))?.id ?? null).toBe(westernNeighbour?.id ?? null);
    expect(meshAt(toMapPoint(MESH_GRID.west - 0.01, 35))).toBeNull();
    expect(meshAt(toMapPoint(MESH_GRID.west + MESH_GRID.width * MESH_GRID.lonStep, 35))).toBeNull();
    expect(meshAt(toMapPoint(139, MESH_GRID.south - 0.01))).toBeNull();
    expect(meshAt(toMapPoint(139, MESH_GRID.south + MESH_GRID.height * MESH_GRID.latStep))).toBeNull();
  });
});
