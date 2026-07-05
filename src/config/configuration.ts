/**
 * Typed configuration loaded from environment variables (via @nestjs/config).
 * Every var is documented in `.env.example`. Defaults here match that file and
 * model a CLEAN, realistic feed out of the box (chaos master switch off).
 */

export interface AppConfig {
  port: number;

  // Simulation
  matchCount: number;
  simMinuteMs: number;
  restartOnFullTime: boolean;

  // Chaos master switch
  chaosEnabled: boolean;

  // Chaos rates
  dupRate: number;
  reorderRate: number;
  reorderMaxDelayMs: number;
  malformedRate: number;

  // Burst
  burstEnabled: boolean;
  burstRandomProbability: number;
  burstSizeMin: number;
  burstSizeMax: number;
  /** Spontaneous (ambient) bursts are small & realistic; on-demand bursts are big. */
  burstAmbientSizeMin: number;
  burstAmbientSizeMax: number;
  burstWindowMs: number;

  // Reversals
  goalCancelProbability: number;
  redRescindProbability: number;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export default (): AppConfig => ({
  port: num(process.env.PORT, 3001),

  matchCount: num(process.env.MATCH_COUNT, 15),
  simMinuteMs: num(process.env.SIM_MINUTE_MS, 1000),
  restartOnFullTime: bool(process.env.RESTART_ON_FULLTIME, true),

  chaosEnabled: bool(process.env.CHAOS_ENABLED, false),

  dupRate: num(process.env.DUP_RATE, 0.02),
  reorderRate: num(process.env.REORDER_RATE, 0.02),
  reorderMaxDelayMs: num(process.env.REORDER_MAX_DELAY_MS, 800),
  malformedRate: num(process.env.MALFORMED_RATE, 0.005),

  burstEnabled: bool(process.env.BURST_ENABLED, true),
  burstRandomProbability: num(process.env.BURST_RANDOM_PROBABILITY, 0.02),
  burstSizeMin: num(process.env.BURST_SIZE_MIN, 20),
  burstSizeMax: num(process.env.BURST_SIZE_MAX, 40),
  burstAmbientSizeMin: num(process.env.BURST_AMBIENT_SIZE_MIN, 3),
  burstAmbientSizeMax: num(process.env.BURST_AMBIENT_SIZE_MAX, 6),
  burstWindowMs: num(process.env.BURST_WINDOW_MS, 1000),

  goalCancelProbability: num(process.env.GOAL_CANCEL_PROBABILITY, 0.06),
  redRescindProbability: num(process.env.RED_RESCIND_PROBABILITY, 0.1),
});
