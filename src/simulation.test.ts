import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SIMULATION_CONFIG } from './config';
import { createSimulation, dateFromElapsedDays, maxAssetScore, stepSimulation, strengthLimit } from './simulation';
import type { Terrain } from './types';

const fixture = vi.hoisted(() => ({ terrain: 'ocean' as 'ocean' | 'land' | 'mountain' }));

// A tiny synthetic census cell keeps the lifecycle independent of the production data.
vi.mock('./data/map', () => ({ START_POINT: { x: 0, y: 0 } }));
vi.mock('./data/cities', () => ({ CITIES: [
  { id: 'test-city', name: 'テスト市', position: { x: 320, y: 0 }, weight: 100_000, radius: 120 },
] }));
vi.mock('./data/mesh', () => {
  const cells = [{ id: 1, position: { x: 320, y: 0 }, population: 20_000_000, reportingCityId: 'test-city' }];
  return {
    POPULATION_CELLS: cells,
    TOTAL_POPULATION: 20_000_000,
    populationCellsNear: (point: { x: number; y: number }, radius: number) => cells.filter((cell) =>
      Math.abs(cell.position.x - point.x) <= radius && Math.abs(cell.position.y - point.y) <= radius),
  };
});
vi.mock('./geo', () => ({
  distance: (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y),
  terrainAt: () => fixture.terrain,
}));

const longRoute = () => [{ x: 0, y: 0 }, { x: 100_000, y: 0 }];

beforeEach(() => { fixture.terrain = 'ocean'; });

describe('typhoon lifecycle', () => {
  it('uses the former four-times travel speed as baseline while the calendar advances more slowly', () => {
    const state = createSimulation(longRoute());
    stepSimulation(state, 10);
    expect(state.traveledDistance).toBeCloseTo(720, 8);
    expect(state.elapsedDays).toBeCloseTo(6, 8);
    expect(state.phase).toBe('running');
  });

  it('recovers strength over warm water while structural recovery is slower', () => {
    const state = createSimulation(longRoute());
    state.strength = 40;
    state.stability = 50;
    stepSimulation(state, 2);
    expect(state.strength).toBeGreaterThan(46);
    expect(state.stability).toBeGreaterThan(51.8);
    expect(state.stability).toBeLessThan(52.2);
    expect(state.strength - 40).toBeGreaterThan((state.stability - 50) * 2.5);
  });

  it('mountains weaken both strength and structure more than plains', () => {
    const simulate = (terrain: Terrain) => {
      fixture.terrain = terrain;
      const state = createSimulation(longRoute());
      stepSimulation(state, 8);
      return state;
    };
    const plain = simulate('land');
    const mountain = simulate('mountain');
    expect(mountain.phase).toBe('running');
    expect(mountain.strength).toBeGreaterThan(15);
    expect(mountain.stability).toBeGreaterThan(50);
    expect(mountain.strength).toBeLessThan(plain.strength);
    expect(mountain.stability).toBeLessThan(plain.stability);
  });

  it('limits strength to what damaged structure can support', () => {
    const state = createSimulation(longRoute());
    state.stability = 25;
    state.strength = 100;
    stepSimulation(state, 1);
    expect(state.strength).toBeLessThanOrEqual(strengthLimit(state.stability));
    expect(state.strength).toBeLessThan(48);
  });

  it('ends as an extratropical low when structure is lost', () => {
    fixture.terrain = 'mountain';
    const state = createSimulation(longRoute());
    state.stability = 14;
    stepSimulation(state, 1);
    expect(state.endReason).toBe('extratropical');
    expect(state.phase).toBe('finished');
  });

  it('ends in winter even if it is still strong and the route continues', () => {
    const state = createSimulation(longRoute());
    state.elapsedDays = 90.99;
    state.strength = 100;
    stepSimulation(state, 1);
    expect(state.endReason).toBe('winter');
    expect(state.elapsedDays).toBe(SIMULATION_CONFIG.winterDay);
  });

  it('cannot live forever by circling warm water', () => {
    const state = createSimulation(longRoute());
    stepSimulation(state, 1_000);
    expect(state.phase).toBe('finished');
    expect(state.endReason).not.toBe('route-complete');
    expect(state.elapsedDays).toBeLessThanOrEqual(91);
    expect(state.events.length).toBeLessThanOrEqual(SIMULATION_CONFIG.maxEvents);
  });

  it('uses the game calendar, including October and December boundaries', () => {
    expect(dateFromElapsedDays(0).toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(dateFromElapsedDays(30).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(dateFromElapsedDays(91).toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
});

describe('finite regional damage', () => {
  it('earns a diminishing share of remaining assets on each distinct equal-strength visit', () => {
    const state = createSimulation([
      { x: 0, y: 0 }, { x: 320, y: 0 }, { x: 0, y: 0 }, { x: 320, y: 0 },
      { x: 0, y: 0 }, { x: 320, y: 0 },
    ]);
    state.strength = 100;
    state.stability = 100;
    stepSimulation(state, 320 / SIMULATION_CONFIG.movementSpeed + 0.02);
    const firstPassScore = state.score;
    expect(firstPassScore).toBeCloseTo(50_000, 5);
    stepSimulation(state, 640 / SIMULATION_CONFIG.movementSpeed);
    expect(state.score).toBeCloseTo(75_000, 5);
    stepSimulation(state, 100);
    expect(state.score).toBeCloseTo(87_500, 5);
    expect(state.score).toBeLessThanOrEqual(maxAssetScore());
    expect(state.cityDamage['test-city'].remaining).toBeCloseTo(12_500, 5);
    expect(state.cityDamage['test-city'].visitCount).toBe(3);
    expect(state.affectedCities).toBe(1);
    const events = state.events.filter((event) => event.kind === 'city');
    expect(events).toHaveLength(3);
    expect(events[1].text).toContain('再直撃');
    expect(events[1].score).toBeGreaterThan(0);
    // Popups report that step's newly damaged mesh share; cadence can change
    // the number shown even though entire passes diminish deterministically.
    expect(events.every((event) => event.score! > 0 && event.score! <= 50_000)).toBe(true);
  });

  it('a weaker revisit still earns from remaining assets without beating the all-time exposure', () => {
    const state = createSimulation([
      { x: 0, y: 0 }, { x: 320, y: 0 }, { x: 0, y: 0 }, { x: 320, y: 0 },
    ]);
    state.strength = 100;
    state.stability = 100;
    stepSimulation(state, 320 / SIMULATION_CONFIG.movementSpeed + 0.02);
    const firstPassScore = state.score;
    state.strength = 30;
    stepSimulation(state, 100);
    expect(state.score).toBeGreaterThan(firstPassScore);
    expect(state.score).toBeLessThan(75_000);
    expect(state.cityDamage['test-city'].peakExposure).toBe(1);
    expect(state.cityDamage['test-city'].visitPeakExposure).toBeLessThan(0.5);
    expect(state.cityDamage['test-city'].visitCount).toBe(2);
  });

  it('tiny loops and prolonged time inside one visit do not consume another share', () => {
    const route = [{ x: 0, y: 0 }, { x: 320, y: 0 }];
    for (let loop = 0; loop < 200; loop++) route.push({ x: 322, y: 0 }, { x: 318, y: 0 });
    route.push({ x: 320, y: 0 });
    const state = createSimulation(route);
    state.strength = 100;
    state.stability = 100;
    stepSimulation(state, 320 / SIMULATION_CONFIG.movementSpeed + 0.02);
    const firstPassScore = state.score;
    stepSimulation(state, 100);
    expect(state.score).toBeCloseTo(firstPassScore, 5);
    expect(state.cityDamage['test-city'].visitCount).toBe(1);
    expect(state.cityDamage['test-city'].remaining).toBeCloseTo(50_000, 5);
    expect(state.events.filter((event) => event.kind === 'city')).toHaveLength(1);
  });

  it('requires a clear exit past the margin rather than boundary flickering to start another visit', () => {
    const route = [{ x: 0, y: 0 }, { x: 320, y: 0 }];
    for (let loop = 0; loop < 4; loop++) route.push({ x: 320 + SIMULATION_CONFIG.meshWindRadius * 1.2, y: 0 }, { x: 320, y: 0 });
    const state = createSimulation(route);
    state.strength = 100;
    state.stability = 100;
    stepSimulation(state, 100);
    expect(state.meshDamage[1].visitCount).toBe(1);
    expect(state.score).toBeCloseTo(50_000, 5);
  });

  it('a stronger revisit increases exposure while retaining all prior damage and finite assets', () => {
    const state = createSimulation([
      { x: 0, y: 0 }, { x: 320, y: 0 }, { x: 0, y: 0 }, { x: 320, y: 0 },
    ]);
    state.strength = 25;
    state.stability = 100;
    stepSimulation(state, 320 / SIMULATION_CONFIG.movementSpeed + 0.02);
    const firstPassScore = state.score;
    stepSimulation(state, 100);
    expect(state.score).toBeGreaterThan(firstPassScore);
    expect(state.score).toBeLessThanOrEqual(100_000);
    const asset = state.cityDamage['test-city'];
    expect(asset.damage + asset.remaining).toBeCloseTo(100_000, 6);
    expect(asset.remaining).toBeCloseTo(asset.visitStartingRemaining * (1 - 0.5 * asset.visitPeakExposure), 6);
    expect(asset.visitCount).toBe(2);
    expect(state.events.filter((event) => event.kind === 'city')).toHaveLength(1);
  });
});

describe('route integration', () => {
  it('ignores consecutive duplicates, preserves loops, and reaches the exact endpoint', () => {
    const state = createSimulation([
      { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 9, y: 0 },
      { x: 9, y: 0 }, { x: 9, y: 9 }, { x: 0, y: 0 },
    ]);
    stepSimulation(state, 100);
    expect(state.route).toHaveLength(4);
    expect(state.endReason).toBe('route-complete');
    expect(state.position).toEqual({ x: 0, y: 0 });
    expect(state.traveledDistance).toBeCloseTo(18 + Math.sqrt(162), 6);
  });

  it('does not skip a city when a large update spans the entire route', () => {
    const state = createSimulation([{ x: 0, y: 0 }, { x: 640, y: 0 }]);
    stepSimulation(state, 20);
    expect(state.score).toBeGreaterThan(20_000);
    expect(state.score).toBeLessThan(50_000);
    expect(state.endReason).toBe('route-complete');
  });

  it('is invariant to how the same elapsed time is split into browser frames', () => {
    const route = [
      { x: 0, y: 0 }, { x: 320, y: 0 }, { x: 0, y: 0 },
      { x: 320, y: 0 }, { x: 0, y: 0 }, { x: 320, y: 0 },
    ];
    const once = createSimulation(route);
    const frames = createSimulation(route);
    stepSimulation(once, 20);
    for (let frame = 0; frame < 1_200; frame++) stepSimulation(frames, 1 / 60);
    expect(frames.position.x).toBeCloseTo(once.position.x, 9);
    expect(frames.strength).toBeCloseTo(once.strength, 9);
    expect(frames.stability).toBeCloseTo(once.stability, 9);
    expect(frames.elapsedDays).toBeCloseTo(once.elapsedDays, 9);
    expect(frames.score).toBeCloseTo(once.score, 9);
    expect(frames.cityDamage['test-city'].visitCount).toBe(once.cityDamage['test-city'].visitCount);
    expect(frames.cityDamage['test-city'].visitCount).toBeGreaterThan(1);
    expect(frames.cityDamage['test-city'].remaining).toBeCloseTo(once.cityDamage['test-city'].remaining, 9);
  });

  it('rejects invalid and empty routes and safely ignores invalid frame durations', () => {
    expect(() => createSimulation([])).toThrow();
    expect(() => createSimulation([{ x: 0, y: 0 }])).toThrow();
    expect(() => createSimulation([{ x: Number.NaN, y: 0 }])).toThrow();
    const state = createSimulation(longRoute());
    for (const duration of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0]) stepSimulation(state, duration);
    expect(state.traveledDistance).toBe(0);
  });
});
