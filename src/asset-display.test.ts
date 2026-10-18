import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assetFill, initialAssetPoints, remainingAssetPoints, remainingAssetsNear } from './asset-display';
import { SIMULATION_CONFIG as CONFIG } from './config';
import { populationCellsNear } from './data/mesh';
import type { CityDamage, Point } from './types';

const fixture = vi.hoisted(() => ({ cells: [
  { id: 1, population: 1_000, position: { x: 0, y: 0 } },
  { id: 2, population: 2_000, position: { x: 10, y: 0 } },
  { id: 3, population: 10_000, position: { x: 60, y: 0 } },
] }));

vi.mock('./data/mesh', () => ({
  populationCellsNear: vi.fn((point: Point, radius: number) => fixture.cells.filter(cell =>
    Math.hypot(cell.position.x - point.x, cell.position.y - point.y) <= radius)),
}));

const asset = (remaining: number): CityDamage => ({
  remaining, damage: 1, peakExposure: 0.5, activeVisit: false,
  visitPeakExposure: 0.5, visitStartingRemaining: remaining + 1,
  visitCount: 1, visitEventEmitted: false,
});

beforeEach(() => vi.clearAllMocks());

describe('remaining asset display', () => {
  it('converts only finite nonnegative population to finite game asset points', () => {
    expect(initialAssetPoints(1_000)).toBe(5);
    for (const population of [0, -1, Number.NaN, Infinity, -Infinity]) {
      expect(initialAssetPoints(population)).toBe(0);
    }
    expect(Number.isFinite(initialAssetPoints(Number.MAX_VALUE))).toBe(true);
  });

  it('shows initial population assets before a run and in untouched cells during a run', () => {
    const cell = fixture.cells[0];
    expect(remainingAssetPoints(cell, null)).toBe(5);
    expect(remainingAssetPoints(cell, { meshDamage: {} })).toBe(5);
    expect(remainingAssetPoints({ id: 4, population: 0 }, null)).toBe(0);
  });

  it('uses the recorded balance, including zero, without restoring depleted assets', () => {
    const state = { meshDamage: { 1: asset(1.25), 2: asset(0) } };
    expect(remainingAssetPoints(fixture.cells[0], state)).toBe(1.25);
    expect(remainingAssetPoints(fixture.cells[1], state)).toBe(0);
  });

  it('adds full local balances, including untouched cells, and excludes distant assets', () => {
    const state = { meshDamage: { 1: asset(0), 3: asset(1) } };
    expect(remainingAssetsNear(null, { x: 0, y: 0 })).toBe(15);
    expect(remainingAssetsNear(state, { x: 0, y: 0 })).toBe(10);
    expect(populationCellsNear).toHaveBeenLastCalledWith({ x: 0, y: 0 }, CONFIG.meshWindRadius);
    // The second cell contributes its full 10pt even near the footprint edge;
    // this is the asset ceiling, without exposure or per-pass yield weighting.
    expect(remainingAssetsNear(state, { x: 0, y: 0 }, 10)).toBe(10);
    expect(remainingAssetsNear(state, { x: 0, y: 0 }, 0)).toBe(0);
    expect(remainingAssetsNear(state, { x: 1_000, y: 0 })).toBe(0);
  });

  it('does not create damage records or consume simulation and rendering state', () => {
    const state = { meshDamage: { 1: asset(1.25) }, meshDamageDirtyIds: new Set([1]), score: 3.75 };
    const before = structuredClone(state);
    for (let frame = 0; frame < 10; frame++) {
      remainingAssetsNear(state, { x: 0, y: 0 });
      remainingAssetPoints(fixture.cells[1], state);
    }
    expect(state).toEqual(before);
    expect(Object.keys(state.meshDamage)).toEqual(['1']);
  });

  it('distinguishes empty, depleted, partial and full assets on a fixed absolute colour scale', () => {
    const empty = assetFill(0, 0);
    const depleted = assetFill(3_000, 0);
    const partial = assetFill(3_000, 1_500);
    const full = assetFill(3_000, 3_000);
    expect(empty).toBe('#d6e5ce');
    expect(depleted).toBe('#9eaaa5');
    expect(full).toBe('#ffd45c');
    expect(new Set([empty, depleted, partial, full]).size).toBe(4);
    expect(assetFill(1, 1)).not.toBe(full);
    expect(assetFill(1_500, 1_500)).not.toBe(partial);
    expect(assetFill(30_000, 30_000)).toBe(full);
    // Half the balance lies between the original full colour and grey in every channel.
    for (let channel = 1; channel < 7; channel += 2) {
      const endpoints = [depleted, full].map(color => parseInt(color.slice(channel, channel + 2), 16));
      const middle = parseInt(partial.slice(channel, channel + 2), 16);
      expect(middle).toBeGreaterThanOrEqual(Math.min(...endpoints));
      expect(middle).toBeLessThanOrEqual(Math.max(...endpoints));
    }
  });

  it('clamps colour inputs to valid finite colours without reviving depleted cells', () => {
    expect(assetFill(100, -1)).toBe(assetFill(100, 0));
    expect(assetFill(100, 200)).toBe(assetFill(100, 100));
    for (const initial of [-1, 0, 1, 3_000, Number.MAX_VALUE, Number.NaN, Infinity, -Infinity]) {
      for (const remaining of [-1, 0, 1, 3_000, Number.MAX_VALUE, Number.NaN, Infinity, -Infinity]) {
        expect(assetFill(initial, remaining)).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
    for (const invalid of [Number.NaN, Infinity, -Infinity]) {
      expect(assetFill(invalid, 100)).toBe(assetFill(0, 0));
      expect(assetFill(100, invalid)).toBe(assetFill(100, 0));
    }
  });
});
