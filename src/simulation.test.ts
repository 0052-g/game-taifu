import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SIMULATION_CONFIG } from './config';
import { createSimulation, dateFromElapsedDays, maxAssetScore, stepSimulation, strengthLimit } from './simulation';
import type { Terrain } from './types';

const fixture = vi.hoisted(() => ({ terrain: 'ocean' as 'ocean' | 'land' | 'mountain' }));

// A tiny synthetic map makes engine rules independent of the hand-drawn Japan data.
vi.mock('./data/map', () => ({ START_POINT: { x: 0, y: 0 } }));
vi.mock('./data/cities', () => ({ CITIES: [
  { id: 'test-city', name: 'テスト市', position: { x: 80, y: 0 }, weight: 100_000, radius: 30 },
] }));
vi.mock('./geo', () => ({
  distance: (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y),
  terrainAt: () => fixture.terrain,
}));

const longRoute = () => [{ x: 0, y: 0 }, { x: 10_000, y: 0 }];

beforeEach(() => { fixture.terrain = 'ocean'; });

describe('typhoon lifecycle', () => {
  it('recovers strength over warm water while structural recovery is slower', () => {
    const state = createSimulation(longRoute());
    state.strength = 40;
    state.stability = 50;
    stepSimulation(state, 2);
    expect(state.strength).toBeGreaterThan(47);
    expect(state.stability).toBeGreaterThan(50);
    expect(state.stability).toBeLessThan(51);
  });

  it('mountains weaken both strength and structure more than plains', () => {
    const simulate = (terrain: Terrain) => {
      fixture.terrain = terrain;
      const state = createSimulation(longRoute());
      stepSimulation(state, 2);
      return state;
    };
    const plain = simulate('land');
    const mountain = simulate('mountain');
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
  it('scores at most the city asset value across repeat visits and crossings', () => {
    const state = createSimulation([
      { x: 0, y: 0 }, { x: 80, y: 0 }, { x: 0, y: 0 }, { x: 80, y: 0 },
    ]);
    state.strength = 100;
    state.stability = 100;
    stepSimulation(state, 80 / SIMULATION_CONFIG.movementSpeed + 0.02);
    const firstPassScore = state.score;
    expect(firstPassScore).toBeCloseTo(100_000, 5);
    stepSimulation(state, 100);
    expect(state.score).toBeCloseTo(firstPassScore, 5);
    expect(state.score).toBeLessThanOrEqual(maxAssetScore());
    expect(state.cityDamage['test-city'].remaining).toBeCloseTo(0, 5);
    expect(state.affectedCities).toBe(1);
  });

  it('a stronger revisit adds only the newly damaged share of the city', () => {
    const state = createSimulation([
      { x: 0, y: 0 }, { x: 80, y: 0 }, { x: 0, y: 0 }, { x: 80, y: 0 },
    ]);
    state.strength = 25;
    state.stability = 100;
    stepSimulation(state, 80 / SIMULATION_CONFIG.movementSpeed + 0.02);
    const firstPassScore = state.score;
    stepSimulation(state, 100);
    expect(state.score).toBeGreaterThan(firstPassScore);
    expect(state.score).toBeLessThanOrEqual(100_000);
    expect(state.cityDamage['test-city'].damage + state.cityDamage['test-city'].remaining).toBeCloseTo(100_000, 6);
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
    const state = createSimulation([{ x: 0, y: 0 }, { x: 160, y: 0 }]);
    stepSimulation(state, 20);
    expect(state.score).toBeGreaterThan(80_000);
    expect(state.endReason).toBe('route-complete');
  });

  it('is invariant to how the same elapsed time is split into browser frames', () => {
    const once = createSimulation(longRoute());
    const frames = createSimulation(longRoute());
    stepSimulation(once, 10);
    for (let frame = 0; frame < 600; frame++) stepSimulation(frames, 1 / 60);
    expect(frames.position.x).toBeCloseTo(once.position.x, 9);
    expect(frames.strength).toBeCloseTo(once.strength, 9);
    expect(frames.stability).toBeCloseTo(once.stability, 9);
    expect(frames.elapsedDays).toBeCloseTo(once.elapsedDays, 9);
    expect(frames.score).toBeCloseTo(once.score, 9);
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
