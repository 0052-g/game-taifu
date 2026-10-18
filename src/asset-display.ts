import { SIMULATION_CONFIG as CONFIG } from './config';
import { populationCellsNear } from './data/mesh';
import type { MeshCell } from './data/mesh';
import type { Point, SimulationState } from './types';

type AssetDisplayState = Readonly<Pick<SimulationState, 'meshDamage'>>;

const NEUTRAL_COLOR = '#d6e5ce';
const DEPLETED_COLOR = '#9eaaa5';
const LOW_ASSET_RGB = [217, 233, 198] as const;
const HIGH_ASSET_RGB = [255, 212, 92] as const;
const DEPLETED_RGB = [158, 170, 165] as const;
const LOG_ASSET_CEILING = Math.log1p(3_000);
const nonNegativeFinite = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;

/** Population-derived initial game assets; invalid population is never a drawable asset. */
export function initialAssetPoints(population: number): number {
  return nonNegativeFinite(population) * CONFIG.meshAssetPointsPerPerson;
}

/**
 * Fixed absolute asset scale: low amounts are pale green, 3,000pt or more are gold.
 * Depletion fades that original colour toward grey; it never renormalizes against
 * other cells or confuses a smaller untouched cell with a depleted large cell.
 */
export function assetFill(initialPoints: number, remainingPoints: number): string {
  const initial = nonNegativeFinite(initialPoints);
  if (initial === 0) return NEUTRAL_COLOR;
  const fraction = Math.min(1, nonNegativeFinite(remainingPoints) / initial);
  if (fraction === 0) return DEPLETED_COLOR;
  const amount = Math.min(1, Math.log1p(initial) / LOG_ASSET_CEILING);
  const channels = LOW_ASSET_RGB.map((low, index) => {
    const full = low + (HIGH_ASSET_RGB[index] - low) * amount;
    return Math.round(DEPLETED_RGB[index] + (full - DEPLETED_RGB[index]) * fraction)
      .toString(16).padStart(2, '0');
  });
  return `#${channels.join('')}`;
}

/** Remaining finite asset points; an unvisited cell still owns its full initial assets. */
export function remainingAssetPoints(
  cell: Pick<MeshCell, 'id' | 'population'>,
  state: AssetDisplayState | null,
): number {
  return state?.meshDamage[cell.id]?.remaining ?? initialAssetPoints(cell.population);
}

/**
 * Full asset balance in the local wind footprint, selected by census-cell centres.
 * This is an upper bound on future score from those cells, not one pass's yield:
 * strength, radial exposure and the per-pass damage fraction are deliberately absent.
 * Reading the display never allocates damage records or consumes renderer notifications.
 */
export function remainingAssetsNear(
  state: AssetDisplayState | null,
  position: Point,
  radius: number = CONFIG.meshWindRadius,
): number {
  let remaining = 0;
  for (const cell of populationCellsNear(position, radius)) remaining += remainingAssetPoints(cell, state);
  return remaining;
}
