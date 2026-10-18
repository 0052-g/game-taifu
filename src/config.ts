/** All game balance values live here; these are playful approximations, not forecasts. */
export const SIMULATION_CONFIG = {
  initialStrength: 58,
  initialStability: 90,
  movementSpeed: 72,
  daysPerSecond: 0.6,
  fixedStepSeconds: 0.02,
  minimumStrength: 5,
  minimumStability: 13,
  winterDay: 91, // September 1 → December 1.
  oceanStrengthRecovery: 3.2,
  oceanStabilityRecovery: 1.15,
  oceanStabilityWear: 0.1,
  coldSeaStrengthDecay: 5,
  coldSeaStabilityDecay: 0.8,
  landStrengthDecay: 2.6,
  landStabilityDecay: 1.35,
  mountainStrengthDecay: 5.2,
  mountainStabilityDecay: 3.2,
  stabilityCapBase: 25,
  stabilityCapFactor: 0.85,
  lifetimeCapacityLossPerDay: 0.28,
  cityExposureExponent: 2,
  // Census population is converted to a game score, never a monetary loss estimate.
  meshAssetPointsPerPerson: 0.005,
  meshWindRadius: 22,
  meshPassDamageFraction: 0.5,
  meshVisitExitMargin: 0.35,
  terrainMountainElevationM: 500,
  terrainMountainReliefM: 300,
  cityEventExposure: 0.25,
  maxEvents: 8,
} as const;

export const CITY_RADIUS = 26;
