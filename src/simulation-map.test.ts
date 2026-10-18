import { describe, expect, it } from 'vitest';
import { SIMULATION_CONFIG as CONFIG } from './config';
import { CITIES } from './data/cities';
import { START_POINT } from './data/map';
import { meshAt, POPULATION_CELLS } from './data/mesh';
import { distance, project } from './geo';
import { createSimulation, maxAssetScore, stepSimulation } from './simulation';
import type { Point } from './types';

const city = (id: string) => CITIES.find((entry) => entry.id === id)!.position;

// These routes use the real coast, GSI-derived terrain, and census population.
// Broad ranges protect playability; the nationwide population determines the asset scale.
const coastalRoute: Point[] = [
  START_POINT, { x: 440, y: 570 }, { x: 445, y: 455 }, city('osaka'),
  { x: 570, y: 432 }, city('nagoya'), { x: 635, y: 419 }, city('tokyo'),
  { x: 735, y: 355 },
];
const mountainCorridor: Point[] = [
  START_POINT, project(131, 31.5), city('kumamoto'), city('fukuoka'),
  city('hiroshima'), project(133.5, 34.9), city('osaka'), project(135.8, 34.1),
  city('nagoya'), project(137.8, 36.1), project(138.7, 36.5), city('tokyo'),
  city('sendai'), project(140.5, 39.5), city('aomori'), city('sapporo'),
];

describe('playability on Japan game geography', () => {
  it('finishes the coastal sample briskly, with a readable calendar and useful power remaining', () => {
    const state = createSimulation(coastalRoute);
    stepSimulation(state, 100);
    expect(state.endReason).toBe('route-complete');
    expect(state.elapsedSeconds).toBeGreaterThan(7);
    expect(state.elapsedSeconds).toBeLessThan(9);
    expect(state.elapsedDays).toBeLessThan(6);
    expect(state.strength).toBeGreaterThan(60);
    expect(state.strength).toBeLessThan(85);
    expect(state.stability).toBeGreaterThan(80);
    // This corridor reaches a large share of Japan's populated Pacific belt;
    // expect a useful share of the nationwide capacity rather than fictional city weights.
    expect(state.score).toBeGreaterThan(maxAssetScore() * 0.08);
    expect(state.score).toBeLessThan(maxAssetScore() * 0.16);
    expect(Object.keys(state.meshDamage).length).toBeGreaterThan(2_000);
    expect(Object.keys(state.meshDamage).length).toBeLessThan(POPULATION_CELLS.length);
    expect(Object.values(state.meshDamage).reduce((sum, asset) => sum + asset.damage, 0)).toBeCloseTo(state.score, 6);
    expect(Object.values(state.cityDamage).reduce((sum, asset) => sum + asset.damage, 0)).toBeCloseTo(state.score, 6);
    expect(Object.values(state.cityDamage).reduce((sum, asset) => sum + asset.damage + asset.remaining, 0)).toBeCloseTo(maxAssetScore(), 6);
  });

  it('scores actual population in Shizuoka outside every major-city hit circle', () => {
    const shizuoka = project(138.38, 34.97);
    expect(CITIES.every((entry) => distance(shizuoka, entry.position) > entry.radius)).toBe(true);
    const localCell = meshAt(shizuoka)!;
    expect(localCell.population).toBeGreaterThan(100_000);
    const state = createSimulation([START_POINT, shizuoka]);
    stepSimulation(state, 100);
    expect(state.endReason).toBe('route-complete');
    const asset = state.meshDamage[localCell.id];
    expect(asset.damage).toBeGreaterThan(0);
    expect(asset.damage + asset.remaining).toBeCloseTo(localCell.population * CONFIG.meshAssetPointsPerPerson, 8);
    expect(state.score).toBeGreaterThan(asset.damage);
    expect(state.score).toBeLessThan(maxAssetScore());
  });

  it('survives a long inland journey across Japan while retaining a substantial mountain penalty', () => {
    const state = createSimulation(mountainCorridor);
    stepSimulation(state, 100);
    expect(state.endReason).toBe('route-complete');
    expect(state.affectedCities).toBeGreaterThanOrEqual(10);
    expect(state.elapsedSeconds).toBeLessThan(15);
    expect(state.elapsedDays).toBeLessThan(9);
    expect(state.strength).toBeGreaterThan(20);
    expect(state.strength).toBeLessThan(50);
    expect(state.stability).toBeGreaterThan(60);
    expect(state.stability).toBeLessThan(85);
  });

  it('still dissipates on a repeated mountain route instead of becoming invincible', () => {
    const route: Point[] = [START_POINT, project(137.6, 35.6)];
    for (let loop = 0; loop < 30; loop++) route.push(project(138.4, 36.4), project(137.6, 35.6));
    const state = createSimulation(route);
    stepSimulation(state, 1_000);
    expect(state.endReason).toBe('dissipated');
    expect(state.traveledDistance).toBeGreaterThan(1_000);
    expect(state.elapsedSeconds).toBeLessThan(30);
  });

  it('cannot farm coastal cities forever by taking long recovery loops over the sea', () => {
    const route: Point[] = [START_POINT];
    for (let loop = 0; loop < 20; loop++) {
      route.push(...coastalRoute.slice(1), { x: 850, y: 500 }, { x: 600, y: 700 }, START_POINT);
    }
    const state = createSimulation(route);
    stepSimulation(state, 10);
    const earlyScore = state.score;
    const earlyStrength = state.strength;
    expect(earlyStrength).toBeLessThan(85);
    stepSimulation(state, 20);
    const middleScore = state.score;
    expect(middleScore - earlyScore).toBeGreaterThan(50_000);
    expect(state.strength).toBeGreaterThan(earlyStrength + 15);
    stepSimulation(state, 30);
    expect(state.score - middleScore).toBeGreaterThan(50_000);
    expect(state.cityDamage.tokyo.visitCount).toBeGreaterThan(1);
    stepSimulation(state, 1_000);
    expect(state.phase).toBe('finished');
    expect(state.endReason).not.toBe('route-complete');
    expect(state.elapsedDays).toBeLessThanOrEqual(91);
    expect(state.elapsedSeconds).toBeLessThan(160);
    expect(state.score).toBeLessThanOrEqual(maxAssetScore());
    for (const asset of Object.values(state.cityDamage)) {
      expect(asset.remaining).toBeGreaterThanOrEqual(0);
      expect(asset.peakExposure).toBeLessThanOrEqual(1);
    }
  });

  it('can rebuild over the sea after mountain travel and earn substantially again in the late game', () => {
    const route: Point[] = [...mountainCorridor];
    for (let loop = 0; loop < 10; loop++) {
      route.push(
        project(145, 42), project(144, 34.5), project(139.7, 33), city('tokyo'),
        { x: 635, y: 419 }, city('nagoya'), { x: 570, y: 432 }, city('osaka'),
        project(134, 32.5), project(139.7, 33),
      );
    }
    const state = createSimulation(route);
    stepSimulation(state, 10);
    const weakenedStrength = state.strength;
    const weakenedStability = state.stability;
    expect(weakenedStrength).toBeLessThan(45);
    stepSimulation(state, 20);
    const middleScore = state.score;
    stepSimulation(state, 30);
    expect(state.phase).toBe('running');
    expect(state.strength).toBeGreaterThan(weakenedStrength + 40);
    expect(state.stability).toBeGreaterThan(weakenedStability + 8);
    expect(state.score - middleScore).toBeGreaterThan(50_000);
    expect(state.score).toBeLessThanOrEqual(maxAssetScore());
  });
});
