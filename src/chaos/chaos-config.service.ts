import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type ChaosMode = 'duplicate' | 'reorder' | 'malformed' | 'burst';

/**
 * Runtime-mutable chaos state, seeded from env at boot. Kept separate from the
 * static AppConfig so the control endpoints can toggle modes live without a
 * restart. The master switch (`enabled`) gates everything: when off, all
 * effective rates are 0 and the feed is perfectly clean.
 */
@Injectable()
export class ChaosConfigService {
  private readonly logger = new Logger('ChaosConfig');

  private enabled: boolean;
  private dupRate: number;
  private reorderRate: number;
  private reorderMaxDelayMs: number;
  private malformedRate: number;
  private burstEnabled: boolean;

  constructor(config: ConfigService) {
    this.enabled = config.get<boolean>('chaosEnabled')!;
    this.dupRate = config.get<number>('dupRate')!;
    this.reorderRate = config.get<number>('reorderRate')!;
    this.reorderMaxDelayMs = config.get<number>('reorderMaxDelayMs')!;
    this.malformedRate = config.get<number>('malformedRate')!;
    this.burstEnabled = config.get<boolean>('burstEnabled')!;
  }

  // Effective rates honour the master switch.
  get isEnabled(): boolean {
    return this.enabled;
  }
  get duplicateRate(): number {
    return this.enabled ? this.dupRate : 0;
  }
  get outOfOrderRate(): number {
    return this.enabled ? this.reorderRate : 0;
  }
  get malformedProbability(): number {
    return this.enabled ? this.malformedRate : 0;
  }
  get maxReorderDelayMs(): number {
    return this.reorderMaxDelayMs;
  }
  get isBurstEnabled(): boolean {
    return this.enabled && this.burstEnabled;
  }

  /** Snapshot for the control/observability endpoint. */
  snapshot(): Record<string, number | boolean> {
    return {
      enabled: this.enabled,
      dupRate: this.dupRate,
      reorderRate: this.reorderRate,
      reorderMaxDelayMs: this.reorderMaxDelayMs,
      malformedRate: this.malformedRate,
      burstEnabled: this.burstEnabled,
    };
  }

  /** Apply a partial update from the control endpoint; returns the new snapshot. */
  update(patch: {
    enabled?: boolean;
    dupRate?: number;
    reorderRate?: number;
    reorderMaxDelayMs?: number;
    malformedRate?: number;
    burstEnabled?: boolean;
  }): Record<string, number | boolean> {
    if (patch.enabled !== undefined) this.enabled = patch.enabled;
    if (patch.dupRate !== undefined) this.dupRate = clamp01(patch.dupRate);
    if (patch.reorderRate !== undefined) this.reorderRate = clamp01(patch.reorderRate);
    if (patch.reorderMaxDelayMs !== undefined) {
      this.reorderMaxDelayMs = Math.max(0, patch.reorderMaxDelayMs);
    }
    if (patch.malformedRate !== undefined) this.malformedRate = clamp01(patch.malformedRate);
    if (patch.burstEnabled !== undefined) this.burstEnabled = patch.burstEnabled;

    this.logger.log(`chaos updated: ${JSON.stringify(this.snapshot())}`);
    return this.snapshot();
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
