import { describe, expect, it } from 'vitest';
import { CITY_LOCATIONS } from './data/city-locations';
import { START_POINT, toMapPoint } from './data/map';
import { MESH_CELLS, isLandAt, meshAt } from './data/mesh';
import { terrainAt } from './geo';

describe('real coastline and elevation terrain classification', () => {
  it('places every named city on land while the typhoon starts in open water', () => {
    expect(CITY_LOCATIONS).toHaveLength(15);
    const oceanCities = CITY_LOCATIONS.filter(city => !isLandAt(toMapPoint(city.longitude, city.latitude)));
    expect(oceanCities.map(city => city.name)).toEqual([]);
    expect(isLandAt(START_POINT)).toBe(false);
    expect(terrainAt(START_POINT)).toBe('ocean');
  });

  it('recognizes Fuji as mountain terrain and low Tokyo and Naha as ordinary land', () => {
    expect(terrainAt(toMapPoint(138.7274, 35.3606))).toBe('mountain');
    expect(terrainAt(toMapPoint(139.70, 35.69))).toBe('land');
    expect(terrainAt(toMapPoint(127.68, 26.21))).toBe('land');
  });

  it('keeps genuine below-sea-level land distinct from ocean and missing elevation', () => {
    // The acquired GSI grid includes reclaimed land around Hachirogata whose
    // sampled maximum as well as mean are below zero; negative height is valid.
    const belowSeaLevel = MESH_CELLS.find(cell => cell.elevationQuality === 'available'
      && cell.maxElevationM !== null && cell.maxElevationM < 0);
    expect(belowSeaLevel).toBeDefined();
    expect(belowSeaLevel!.elevationM).toBeLessThan(0);
    expect(belowSeaLevel!.demCoverage).toBeGreaterThan(0);
    expect(meshAt(belowSeaLevel!.position)).toBe(belowSeaLevel);
    expect(isLandAt(belowSeaLevel!.position)).toBe(true);
    expect(terrainAt(belowSeaLevel!.position)).toBe('land');
  });
});
