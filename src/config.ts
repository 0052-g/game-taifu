/** All game balance values live here; these are playful approximations, not forecasts. */
export const SIMULATION_CONFIG = {
  initialStrength: 76,
  initialStability: 90,
  movementSpeed: 18,
  daysPerSecond: 1.2,
  fixedStepSeconds: 0.02,
  minimumStrength: 5,
  minimumStability: 13,
  winterDay: 91, // September 1 → December 1.
  oceanStrengthRecovery: 4,
  oceanStabilityRecovery: 0.35,
  oceanStabilityWear: 0.1,
  coldSeaStrengthDecay: 5,
  coldSeaStabilityDecay: 0.8,
  landStrengthDecay: 4.6,
  landStabilityDecay: 2.8,
  mountainStrengthDecay: 9,
  mountainStabilityDecay: 6.5,
  stabilityCapBase: 25,
  stabilityCapFactor: 0.85,
  lifetimeCapacityLossPerDay: 0.28,
  cityExposureExponent: 2,
  cityEventExposure: 0.25,
  maxEvents: 8,
} as const;

export const CITY_RADIUS = 26;

/** Fictional, replaceable asset values. These do not represent actual losses or population. */
export const CITY_WEIGHTS: Record<string, number> = {
  sapporo: 40_000,
  aomori: 15_000,
  sendai: 35_000,
  niigata: 24_000,
  tokyo: 120_000,
  nagoya: 65_000,
  kanazawa: 22_000,
  osaka: 85_000,
  kobe: 40_000,
  hiroshima: 35_000,
  takamatsu: 18_000,
  fukuoka: 45_000,
  kumamoto: 24_000,
  kagoshima: 22_000,
  naha: 15_000,
};
