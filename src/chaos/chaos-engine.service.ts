import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Subscription } from 'rxjs';
import { EventsGateway } from '../gateway/events.gateway';
import { MatchSimulatorService } from '../simulator/match-simulator.service';
import { isLifecycleType, MatchEvent } from '../types/match-event';
import { ChaosConfigService } from './chaos-config.service';

interface PendingDelivery {
  seq: number;
  frame: string;
  timer: ReturnType<typeof setTimeout>;
  /** True = a held PRIMARY delivery that must be flushed, not dropped (rule #3). */
  primary: boolean;
}

/**
 * Applies delivery-path distortions to the clean canonical stream. It NEVER
 * touches the canonical log — it only decides how (and whether cleanly) each
 * event reaches the socket.
 *
 * Guarantees:
 *  - Lifecycle events (KICK_OFF/…/FULL_TIME) are always delivered exactly once,
 *    cleanly — never malformed, never reordered (correctness #2).
 *  - Reorder only reorders: on FULL_TIME, all held frames for that match are
 *    flushed in seq order BEFORE the FULL_TIME frame, so nothing is lost and
 *    nothing arrives after the terminal event (correctness #3).
 */
@Injectable()
export class ChaosEngineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ChaosEngine');
  private sub?: Subscription;

  /** Held/deferred deliveries per match, so FULL_TIME can flush them. */
  private readonly pending = new Map<string, Set<PendingDelivery>>();

  constructor(
    private readonly simulator: MatchSimulatorService,
    private readonly gateway: EventsGateway,
    private readonly chaos: ChaosConfigService,
  ) {}

  onModuleInit(): void {
    this.sub = this.simulator.canonicalEvents$.subscribe((event) =>
      this.handle(event),
    );
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
    for (const set of this.pending.values()) {
      for (const p of set) clearTimeout(p.timer);
    }
    this.pending.clear();
  }

  // ── Core dispatch ─────────────────────────────────────────────────────────

  private handle(event: MatchEvent): void {
    const clean = JSON.stringify(event);

    // Lifecycle events are never distorted.
    if (isLifecycleType(event.type)) {
      if (event.type === 'FULL_TIME') {
        this.flush(event.matchId); // deliver any held frames first (rule #3)
      }
      this.gateway.deliver(event.matchId, clean);
      return;
    }

    // 1) Malformed — clean frame NEVER reaches the socket; leaves a seq gap.
    if (Math.random() < this.chaos.malformedProbability) {
      const corrupted = this.corrupt(event);
      this.logger.warn(
        `[CHAOS] malformed seq=${event.seq} (${event.matchId})`,
      );
      this.gateway.deliver(event.matchId, corrupted);
      return;
    }

    // How many copies to send (duplicate injection).
    let copies = 1;
    if (Math.random() < this.chaos.duplicateRate) {
      copies = 2 + (Math.random() < 0.5 ? 0 : 1); // 2 or 3 total
      this.logger.warn(
        `[CHAOS] duplicated seq=${event.seq} x${copies} (${event.matchId})`,
      );
    }

    // 2) Out-of-order — hold the delivery briefly so seq arrives non-monotonic.
    if (Math.random() < this.chaos.outOfOrderRate) {
      const delay = 50 + Math.floor(Math.random() * this.chaos.maxReorderDelayMs);
      this.logger.warn(
        `[CHAOS] reordered seq=${event.seq} +${delay}ms (${event.matchId})`,
      );
      this.deferDelivery(event.matchId, event.seq, clean, delay, true);
      // Extra duplicate copies of a reordered event also ride along, slightly
      // after, as non-primary (droppable) deliveries.
      for (let i = 1; i < copies; i += 1) {
        this.deferDelivery(event.matchId, event.seq, clean, delay + 30 * i, false);
      }
      return;
    }

    // 3) Normal (possibly duplicated) — deliver now; extra copies back-to-back
    //    or a few hundred ms later.
    this.gateway.deliver(event.matchId, clean);
    for (let i = 1; i < copies; i += 1) {
      if (Math.random() < 0.5) {
        this.gateway.deliver(event.matchId, clean); // back-to-back
      } else {
        this.deferDelivery(
          event.matchId,
          event.seq,
          clean,
          50 + Math.floor(Math.random() * 350),
          false,
        );
      }
    }
  }

  // ── Deferred delivery bookkeeping ─────────────────────────────────────────

  private deferDelivery(
    matchId: string,
    seq: number,
    frame: string,
    delay: number,
    primary: boolean,
  ): void {
    const set = this.pending.get(matchId) ?? new Set<PendingDelivery>();
    this.pending.set(matchId, set);

    const entry: PendingDelivery = {
      seq,
      frame,
      primary,
      timer: setTimeout(() => {
        set.delete(entry);
        this.gateway.deliver(matchId, frame);
      }, delay),
    };
    set.add(entry);
  }

  /**
   * Force-deliver all held PRIMARY frames for a match (in seq order) and cancel
   * everything pending. Called on FULL_TIME so a reordered event is never lost
   * and never arrives after the terminal frame.
   */
  private flush(matchId: string): void {
    const set = this.pending.get(matchId);
    if (!set || set.size === 0) return;

    const primaries = [...set].filter((p) => p.primary).sort((a, b) => a.seq - b.seq);
    for (const p of set) clearTimeout(p.timer);
    set.clear();
    this.pending.delete(matchId);

    if (primaries.length > 0) {
      this.logger.warn(
        `[CHAOS] flushing ${primaries.length} held frame(s) before FULL_TIME (${matchId})`,
      );
    }
    for (const p of primaries) {
      this.gateway.deliver(matchId, p.frame);
    }
  }

  // ── Corruption variants ───────────────────────────────────────────────────

  /** Produce a corrupted frame. Returns a raw string (may be invalid JSON). */
  private corrupt(event: MatchEvent): string {
    const variant = Math.floor(Math.random() * 4);
    switch (variant) {
      case 0: {
        // Missing a required field (drop `type`).
        const { type: _drop, ...rest } = event;
        return JSON.stringify(rest);
      }
      case 1: {
        // Wrong type for a field (seq as a string, minute as boolean).
        return JSON.stringify({ ...event, seq: String(event.seq), minute: true });
      }
      case 2: {
        // Unknown event type.
        return JSON.stringify({ ...event, type: 'GLITCH_EVENT' });
      }
      default: {
        // Genuinely invalid JSON (truncated frame).
        return `{"eventId":"${event.eventId}","matchId":"${event.matchId}","seq":${event.seq},"type":`;
      }
    }
  }
}
