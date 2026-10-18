import { SIMULATION_CONFIG as CONFIG } from './config';
import { CITIES } from './data/cities';
import { START_POINT } from './data/map';
import { POPULATION_CELLS, TOTAL_POPULATION, populationCellsNear } from './data/mesh';
import { distance, terrainAt } from './geo';
import type { CityDamage, EndReason, Point, SimulationEvent, SimulationState, Terrain } from './types';

const EPSILON = 1e-9;
// Built once. Every update visits only nearby cells and the previous local footprint.
const POPULATION_CELL_BY_ID = new Map(POPULATION_CELLS.map((cell) => [cell.id, cell]));
const TERRAIN_LABELS: Record<Terrain, string> = {
  ocean: '海に戻った！暖かい海でパワーチャージ',
  land: '上陸！勢力と構造が少しずつダウン',
  mountain: '山越え！台風の構造が大きく崩れる',
};

export const END_REASON_LABELS: Record<EndReason, string> = {
  'route-complete': '描いた進路を走りきった！',
  dissipated: 'パワーを使い果たして消滅！',
  extratropical: '構造が崩れて温帯低気圧に！',
  winter: '12月到来！冷たい海でシーズン終了',
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The date is a game clock, independent of the user's real clock and timezone. */
export function dateFromElapsedDays(elapsedDays: number): Date {
  return new Date(Date.UTC(2026, 8, 1) + Math.max(0, elapsedDays) * 86_400_000);
}

export function strengthLimit(stability: number): number {
  return clamp(CONFIG.stabilityCapBase + stability * CONFIG.stabilityCapFactor, 0, 100);
}

export function maxAssetScore(): number {
  return TOTAL_POPULATION * CONFIG.meshAssetPointsPerPerson;
}

function emit(state: SimulationState, event: Omit<SimulationEvent, 'id' | 'position'>): void {
  state.events.push({ ...event, id: state.nextEventId++, position: { ...state.position } });
  if (state.events.length > CONFIG.maxEvents) state.events.shift();
}

function finish(state: SimulationState, reason: EndReason): void {
  state.phase = 'finished';
  state.endReason = reason;
  state.accumulator = 0;
  emit(state, { kind: 'end', text: END_REASON_LABELS[reason] });
}

/** Route intersections and revisits are preserved. Only consecutive duplicate points are removed. */
export function createSimulation(route: Point[]): SimulationState {
  if (route.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    throw new Error('進路に無効な座標が含まれています。');
  }
  const cleanRoute: Point[] = [{ ...START_POINT }];
  for (const point of route) {
    if (distance(cleanRoute[cleanRoute.length - 1], point) > EPSILON) cleanRoute.push({ ...point });
  }
  if (cleanRoute.length < 2) throw new Error('台風から進路を描いてください。');
  const cityDamage = Object.fromEntries(CITIES.map((city) => [city.id, createAsset(city.weight)]));
  return {
    route: cleanRoute,
    position: { ...START_POINT },
    strength: CONFIG.initialStrength,
    stability: CONFIG.initialStability,
    elapsedDays: 0,
    elapsedSeconds: 0,
    score: 0,
    cityDamage,
    meshDamage: {},
    activeMeshIds: new Set(),
    traveledDistance: 0,
    maxStrength: CONFIG.initialStrength,
    terrain: terrainAt(START_POINT),
    phase: 'running',
    endReason: null,
    events: [],
    affectedCities: 0,
    routeSegment: 0,
    segmentProgress: 0,
    accumulator: 0,
    nextEventId: 1,
    lastSeason: 0,
  };
}

function createAsset(weight: number): CityDamage {
  return {
    remaining: weight,
    damage: 0,
    peakExposure: 0,
    activeVisit: false,
    visitPeakExposure: 0,
    visitStartingRemaining: weight,
    visitCount: 0,
    visitEventEmitted: false,
  };
}

function enterVisit(asset: CityDamage): void {
  asset.activeVisit = true;
  asset.visitPeakExposure = 0;
  asset.visitStartingRemaining = asset.remaining;
  asset.visitCount++;
  asset.visitEventEmitted = false;
}

function exposureAt(strength: number, radial: number): number {
  const influence = radial * radial * (3 - 2 * radial);
  return Math.pow(strength / 100, CONFIG.cityExposureExponent) * influence;
}

function updateDamage(state: SimulationState): void {
  // City centers trigger readable labels only. Every person belongs to exactly one
  // underlying census cell, so overlapping urban labels never duplicate assets.
  for (const city of CITIES) {
    const group = state.cityDamage[city.id];
    const separation = distance(state.position, city.position);
    if (group.activeVisit && separation > city.radius * (1 + CONFIG.meshVisitExitMargin)) {
      group.activeVisit = false;
    }
    if (!group.activeVisit && separation < city.radius) enterVisit(group);
    const exposure = exposureAt(state.strength, Math.max(0, 1 - separation / city.radius));
    group.peakExposure = Math.max(group.peakExposure, exposure);
    if (group.activeVisit) group.visitPeakExposure = Math.max(group.visitPeakExposure, exposure);
  }

  const exitRadius = CONFIG.meshWindRadius * (1 + CONFIG.meshVisitExitMargin);
  for (const id of state.activeMeshIds) {
    const cell = POPULATION_CELL_BY_ID.get(id)!;
    if (distance(state.position, cell.position) > exitRadius) {
      state.meshDamage[id].activeVisit = false;
      state.activeMeshIds.delete(id);
    }
  }

  const newlyDamagedByCity: Record<string, number> = {};
  for (const cell of populationCellsNear(state.position, CONFIG.meshWindRadius)) {
    const radial = 1 - distance(state.position, cell.position) / CONFIG.meshWindRadius;
    if (radial <= 0) continue;
    const weight = cell.population * CONFIG.meshAssetPointsPerPerson;
    const asset = state.meshDamage[cell.id] ??= createAsset(weight);
    if (asset.remaining <= EPSILON) continue;
    if (!asset.activeVisit) {
      enterVisit(asset);
      state.activeMeshIds.add(cell.id);
    }
    const exposure = exposureAt(state.strength, radial);
    asset.peakExposure = Math.max(asset.peakExposure, exposure);
    if (exposure <= asset.visitPeakExposure) continue;
    asset.visitPeakExposure = exposure;
    // A pass consumes at most half of the assets present at entry. Waiting and
    // tiny loops cannot drain more; exiting the footprint permits another pass.
    const remaining = Math.max(0, asset.visitStartingRemaining * (1 - CONFIG.meshPassDamageFraction * exposure));
    const increment = Math.max(0, asset.remaining - remaining);
    asset.remaining = remaining;
    asset.damage = weight - remaining;
    if (increment <= 0) continue;
    state.score += increment;
    const group = state.cityDamage[cell.reportingCityId];
    if (group.damage === 0) state.affectedCities++;
    group.damage += increment;
    group.remaining = Math.max(0, group.remaining - increment);
    newlyDamagedByCity[cell.reportingCityId] = (newlyDamagedByCity[cell.reportingCityId] ?? 0) + increment;
  }

  for (const city of CITIES) {
    const group = state.cityDamage[city.id];
    const increment = newlyDamagedByCity[city.id] ?? 0;
    if (group.activeVisit && !group.visitEventEmitted && increment > 0 &&
      exposureAt(state.strength, Math.max(0, 1 - distance(state.position, city.position) / city.radius)) >= CONFIG.cityEventExposure) {
      group.visitEventEmitted = true;
      emit(state, {
        kind: 'city',
        text: `${city.name}に${group.visitCount > 1 ? '再' : ''}直撃！`,
        score: Math.round(increment),
      });
    }
  }
}

function updateWeather(state: SimulationState, seconds: number): void {
  const terrain = terrainAt(state.position);
  if (terrain !== state.terrain) {
    state.terrain = terrain;
    emit(state, { kind: 'terrain', text: TERRAIN_LABELS[terrain] });
  }
  const warmth = state.elapsedDays <= 30
    ? 1 - state.elapsedDays / 100
    : Math.max(0, 0.7 * (CONFIG.winterDay - state.elapsedDays) / (CONFIG.winterDay - 30));
  const cold = clamp((state.elapsedDays - 30) / (CONFIG.winterDay - 30), 0, 1);
  let strengthRate: number;
  let stabilityRate: number;
  if (terrain === 'ocean') {
    strengthRate = CONFIG.oceanStrengthRecovery * warmth - CONFIG.coldSeaStrengthDecay * cold;
    stabilityRate = CONFIG.oceanStabilityRecovery * warmth - CONFIG.oceanStabilityWear
      - CONFIG.coldSeaStabilityDecay * cold;
  } else if (terrain === 'mountain') {
    strengthRate = -CONFIG.mountainStrengthDecay;
    stabilityRate = -CONFIG.mountainStabilityDecay;
  } else {
    strengthRate = -CONFIG.landStrengthDecay;
    stabilityRate = -CONFIG.landStabilityDecay;
  }
  // Aging lowers the recoverable structure ceiling even if the route loops over warm water.
  const structuralCapacity = Math.max(0, 100 - state.elapsedDays * CONFIG.lifetimeCapacityLossPerDay);
  state.stability = clamp(state.stability + stabilityRate * seconds, 0, structuralCapacity);
  const previousStrength = state.strength;
  state.strength = clamp(state.strength + strengthRate * seconds, 0, strengthLimit(state.stability));
  state.maxStrength = Math.max(state.maxStrength, state.strength);
  if (previousStrength > 30 && state.strength <= 30) {
    emit(state, { kind: 'warning', text: '勢力が30以下！そろそろ限界…' });
  }
  const season = state.elapsedDays >= 61 ? 2 : state.elapsedDays >= 30 ? 1 : 0;
  if (season !== state.lastSeason) {
    state.lastSeason = season;
    emit(state, { kind: 'season', text: season === 1 ? '10月！海のパワーが落ちてきた' : '11月！冷たい海で台風も冬じたく' });
  }
}

function advanceFixedStep(state: SimulationState, requestedSeconds: number): void {
  let remainingSeconds = requestedSeconds;
  // Split at polyline corners as well as the fixed timestep, so a tiny crossed segment is never skipped.
  while (remainingSeconds > EPSILON && state.phase === 'running') {
    const start = state.route[state.routeSegment];
    const target = state.route[state.routeSegment + 1];
    if (!target) {
      finish(state, 'route-complete');
      return;
    }
    const segmentLength = distance(start, target);
    const distanceLeft = Math.max(0, segmentLength - state.segmentProgress);
    const winterSeconds = Math.max(0, (CONFIG.winterDay - state.elapsedDays) / CONFIG.daysPerSecond);
    const seconds = Math.min(remainingSeconds, distanceLeft / CONFIG.movementSpeed, winterSeconds);
    const moved = seconds * CONFIG.movementSpeed;
    state.segmentProgress += moved;
    state.traveledDistance += moved;
    const fraction = segmentLength > 0 ? Math.min(1, state.segmentProgress / segmentLength) : 1;
    state.position = { x: start.x + (target.x - start.x) * fraction, y: start.y + (target.y - start.y) * fraction };
    state.elapsedSeconds += seconds;
    state.elapsedDays = Math.min(CONFIG.winterDay, state.elapsedDays + seconds * CONFIG.daysPerSecond);
    updateWeather(state, seconds);
    updateDamage(state);
    remainingSeconds -= seconds;

    if (state.elapsedDays >= CONFIG.winterDay - EPSILON) finish(state, 'winter');
    else if (state.stability <= CONFIG.minimumStability) finish(state, 'extratropical');
    else if (state.strength <= CONFIG.minimumStrength) finish(state, 'dissipated');
    else if (state.segmentProgress >= segmentLength - EPSILON) {
      state.routeSegment++;
      state.segmentProgress = 0;
      if (state.routeSegment >= state.route.length - 1) finish(state, 'route-complete');
    }
  }
}

/** Deterministic, DOM-free engine. Any non-negative frame duration is safe, including large updates. */
export function stepSimulation(state: SimulationState, dtSeconds: number): void {
  if (state.phase !== 'running' || !Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
  state.accumulator += dtSeconds;
  while (state.accumulator + EPSILON >= CONFIG.fixedStepSeconds && state.phase === 'running') {
    state.accumulator = Math.max(0, state.accumulator - CONFIG.fixedStepSeconds);
    advanceFixedStep(state, CONFIG.fixedStepSeconds);
  }
}
