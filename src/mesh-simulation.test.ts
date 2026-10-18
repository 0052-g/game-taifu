import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SIMULATION_CONFIG as CONFIG } from './config';
import { createSimulation, maxAssetScore, stepSimulation } from './simulation';

const fixture = vi.hoisted(() => ({ queries: 0, returnedCells: 0 }));

vi.mock('./data/map', () => ({ START_POINT: { x: 0, y: 0 } }));
vi.mock('./data/cities', () => ({ CITIES: [
  { id: 'a', name: 'A市', position: { x: 320, y: 0 }, weight: 15, radius: 26 },
  { id: 'b', name: 'B市', position: { x: 326, y: 0 }, weight: 15, radius: 26 },
] }));
vi.mock('./geo', () => ({
  distance: (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y),
  terrainAt: () => 'ocean',
}));
vi.mock('./data/mesh', () => {
  const cells = [
    { id: 1, position: { x: 320, y: 0 }, population: 1_000, reportingCityId: 'a' },
    { id: 2, position: { x: 326, y: 0 }, population: 3_000, reportingCityId: 'b' },
    // People outside either display city's hit radius must also contribute.
    { id: 3, position: { x: 850, y: 0 }, population: 2_000, reportingCityId: 'a' },
  ];
  return {
    POPULATION_CELLS: cells,
    TOTAL_POPULATION: 6_000,
    populationCellsNear: (point: { x: number; y: number }, radius: number) => {
      fixture.queries++;
      const nearby = cells.filter((cell) => Math.abs(point.x - cell.position.x) <= radius && Math.abs(point.y - cell.position.y) <= radius);
      fixture.returnedCells += nearby.length;
      return nearby;
    },
  };
});

beforeEach(() => { fixture.queries = 0; fixture.returnedCells = 0; });

const strongStorm = (route: { x: number; y: number }[]) => {
  const state = createSimulation(route);
  state.strength = 100;
  state.stability = 100;
  return state;
};

function expectConserved(state: ReturnType<typeof createSimulation>): void {
  const cells = Object.values(state.meshDamage);
  const groups = Object.values(state.cityDamage);
  expect(cells.reduce((total, asset) => total + asset.damage, 0)).toBeCloseTo(state.score, 10);
  expect(groups.reduce((total, asset) => total + asset.damage, 0)).toBeCloseTo(state.score, 10);
  expect(groups.reduce((total, asset) => total + asset.remaining + asset.damage, 0)).toBeCloseTo(maxAssetScore(), 10);
  for (const asset of cells) {
    expect(asset.remaining).toBeGreaterThanOrEqual(0);
    expect(asset.damage).toBeGreaterThanOrEqual(0);
  }
  expect(state.score).toBeLessThanOrEqual(maxAssetScore());
}

describe('census-mesh finite assets', () => {
  it('allocates assets lazily and scores population away from all major city hit radii', () => {
    const state = strongStorm([{ x: 750, y: 0 }, { x: 850, y: 0 }]);
    expect(Object.keys(state.meshDamage)).toHaveLength(0);
    stepSimulation(state, 750 / CONFIG.movementSpeed);
    const beforeRemoteCell = state.score;
    expect(state.meshDamage[3]).toBeUndefined();
    stepSimulation(state, 10);
    expect(state.score - beforeRemoteCell).toBeCloseTo(5, 8);
    expect(state.meshDamage[3].damage).toBeCloseTo(5, 8);
    expect(state.cityDamage.a.damage).toBeGreaterThan(7.4);
    expect(state.events.filter((event) => event.kind === 'city')).toHaveLength(2);
    expectConserved(state);
  });

  it('counts each census cell once even where multiple city labels overlap', () => {
    const state = strongStorm([{ x: 320, y: 0 }, { x: 326, y: 0 }, { x: 850, y: 0 }]);
    stepSimulation(state, 100);
    expect(maxAssetScore()).toBe(30);
    expect(state.score).toBeCloseTo(15, 8);
    expect(state.meshDamage[1].damage).toBeCloseTo(2.5, 8);
    expect(state.meshDamage[2].damage).toBeCloseTo(7.5, 8);
    expect(state.meshDamage[3].damage).toBeCloseTo(5, 8);
    expect(state.cityDamage.a.damage).toBeCloseTo(7.5, 8);
    expect(state.cityDamage.b.damage).toBeCloseTo(7.5, 8);
    expectConserved(state);
  });

  it('retains a finite reserve while later distinct visits still earn points', () => {
    const route = [{ x: 320, y: 0 }, { x: 326, y: 0 }, { x: 850, y: 0 }];
    for (let pass = 0; pass < 4; pass++) {
      route.push({ x: 950, y: 0 }, { x: 320, y: 0 }, { x: 326, y: 0 }, { x: 850, y: 0 });
    }
    const state = strongStorm(route);
    stepSimulation(state, 12);
    const early = state.score;
    stepSimulation(state, 20);
    expect(state.score).toBeGreaterThan(early);
    expect(state.meshDamage[3].visitCount).toBeGreaterThan(1);
    expect(state.score).toBeLessThan(maxAssetScore());
    expect(state.cityDamage.a.remaining + state.cityDamage.b.remaining).toBeGreaterThan(0);
    expectConserved(state);
  });

  it('queries only a local footprint and never allocates off-route assets', () => {
    const state = strongStorm([{ x: 100, y: 0 }]);
    stepSimulation(state, 10);
    expect(fixture.queries).toBeGreaterThan(0);
    expect(fixture.returnedCells).toBe(0);
    expect(Object.keys(state.meshDamage)).toHaveLength(0);
    expect(state.score).toBe(0);
  });

  it('coalesces only changed mesh IDs until the renderer consumes them, then notifies revisits', () => {
    const route = [{ x: 320, y: 0 }, { x: 326, y: 0 }, { x: 850, y: 0 }];
    for (let loop = 0; loop < 3; loop++) route.push({ x: 853, y: 0 }, { x: 847, y: 0 });
    route.push({ x: 850, y: 0 }, { x: 950, y: 0 }, { x: 850, y: 0 });
    const state = strongStorm(route);
    expect(state.meshDamageDirtyIds.size).toBe(0);
    stepSimulation(state, 850 / CONFIG.movementSpeed + 0.02);
    expect([...state.meshDamageDirtyIds].sort()).toEqual([1, 2, 3]);
    state.meshDamageDirtyIds.clear();
    const peakScore = state.score;
    stepSimulation(state, 0.2);
    expect(state.score).toBe(peakScore);
    expect(state.meshDamageDirtyIds.size).toBe(0);
    stepSimulation(state, 100);
    expect(state.score).toBeGreaterThan(peakScore);
    expect([...state.meshDamageDirtyIds]).toEqual([3]);
  });

  it('keeps mesh visits and grouped totals deterministic across browser frame rates', () => {
    const route = [{ x: 320, y: 0 }, { x: 950, y: 0 }, { x: 320, y: 0 }];
    const once = strongStorm(route);
    const frames = strongStorm(route);
    stepSimulation(once, 20);
    for (let frame = 0; frame < 1_200; frame++) {
      stepSimulation(frames, 1 / 60);
      frames.meshDamageDirtyIds.clear(); // Rendering notifications cannot alter simulation results.
    }
    expect(frames.score).toBeCloseTo(once.score, 10);
    expect(frames.meshDamage).toEqual(once.meshDamage);
    expect(frames.cityDamage).toEqual(once.cityDamage);
    expectConserved(frames);
  });
});
