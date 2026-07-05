import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subject } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { AppConfig } from '../config/configuration';
import {
  EventType,
  InPlayEventType,
  MatchEvent,
  Team,
} from '../types/match-event';
import {
  createMatch,
  MatchState,
  pick,
  PlannedEvent,
  randInt,
  randomPlayer,
  randomTeam,
} from './match.model';

/** Public summary of a match for the /matches endpoint. */
export interface MatchSummary {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  status: string;
  minute: number;
  /** Highest seq committed so far (seq high-water-mark). */
  seqHighWater: number;
  score: { home: number; away: number };
}

const BURST_TYPES: readonly InPlayEventType[] = [
  // A believable intense spell: a mix of cards, subs and offsides — NOT goals, and
  // no single type dominating (an old 3:1 offside bias read as "10 offsides a minute").
  'YELLOW_CARD', 'SUBSTITUTION', 'OFFSIDE', 'YELLOW_CARD', 'SUBSTITUTION', 'OFFSIDE',
];

/**
 * Generates the CLEAN canonical event stream. Knows nothing about chaos.
 *
 * - Each match runs its own sim clock (setInterval at SIM_MINUTE_MS).
 * - Every event is committed via the single synchronous `commit()` method, which
 *   is the ONLY place seq is assigned — so tick-driven and burst-driven commits
 *   share one monotonic per-match counter with no interleaving (correctness #4).
 * - Emits each committed event on `canonicalEvents$`; ChaosEngine consumes that.
 */
@Injectable()
export class MatchSimulatorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('MatchSimulator');
  private readonly cfg: AppConfig;

  /** All matches ever created, keyed by matchId (finished ones kept for REST). */
  private readonly matches = new Map<string, MatchState>();
  private matchCounter = 0;

  private readonly canonicalEvents = new Subject<MatchEvent>();
  /** The clean canonical stream — one `next` per committed event. */
  readonly canonicalEvents$ = this.canonicalEvents.asObservable();

  constructor(config: ConfigService) {
    // configuration.ts registers the whole AppConfig object under no namespace,
    // so individual keys are readable via get<T>(key).
    this.cfg = {
      port: config.get<number>('port')!,
      matchCount: config.get<number>('matchCount')!,
      simMinuteMs: config.get<number>('simMinuteMs')!,
      restartOnFullTime: config.get<boolean>('restartOnFullTime')!,
      chaosEnabled: config.get<boolean>('chaosEnabled')!,
      dupRate: config.get<number>('dupRate')!,
      reorderRate: config.get<number>('reorderRate')!,
      reorderMaxDelayMs: config.get<number>('reorderMaxDelayMs')!,
      malformedRate: config.get<number>('malformedRate')!,
      burstEnabled: config.get<boolean>('burstEnabled')!,
      burstRandomProbability: config.get<number>('burstRandomProbability')!,
      burstSizeMin: config.get<number>('burstSizeMin')!,
      burstSizeMax: config.get<number>('burstSizeMax')!,
      burstAmbientSizeMin: config.get<number>('burstAmbientSizeMin')!,
      burstAmbientSizeMax: config.get<number>('burstAmbientSizeMax')!,
      burstWindowMs: config.get<number>('burstWindowMs')!,
      goalCancelProbability: config.get<number>('goalCancelProbability')!,
      redRescindProbability: config.get<number>('redRescindProbability')!,
    };
  }

  onModuleInit(): void {
    for (let i = 0; i < this.cfg.matchCount; i += 1) {
      this.spawnMatch();
    }
    this.logger.log(
      `Started ${this.cfg.matchCount} matches @ ${this.cfg.simMinuteMs}ms/sim-min ` +
        `(full match ~${(90 * this.cfg.simMinuteMs) / 1000}s)`,
    );
  }

  onModuleDestroy(): void {
    for (const match of this.matches.values()) {
      if (match.clock) clearInterval(match.clock);
      for (const t of match.burstTimers) clearTimeout(t);
    }
  }

  // ── Match lifecycle ──────────────────────────────────────────────────────

  private nextMatchId(): string {
    this.matchCounter += 1;
    return `match_${String(this.matchCounter).padStart(3, '0')}`;
  }

  private spawnMatch(): void {
    const matchId = this.nextMatchId();
    const match = createMatch(
      matchId,
      this.cfg.goalCancelProbability,
      this.cfg.redRescindProbability,
    );
    this.matches.set(matchId, match);
    this.startClock(match);
  }

  private startClock(match: MatchState): void {
    // Minute 0 fires immediately: KICK_OFF.
    this.advanceTo(match, 0);
    match.clock = setInterval(() => {
      match.simMinute += 1;
      this.advanceTo(match, match.simMinute);
      if (match.simMinute >= 90) {
        if (match.clock) clearInterval(match.clock);
      }
    }, this.cfg.simMinuteMs);
  }

  /** Handle everything that happens at a given sim-minute for one match. */
  private advanceTo(match: MatchState, minute: number): void {
    if (minute === 0) {
      this.commitLifecycle(match, 'KICK_OFF', minute);
      this.logger.log(
        `KICK_OFF  ${match.matchId}  ${match.homeTeam} vs ${match.awayTeam}`,
      );
      return;
    }

    if (minute === 45) {
      this.commitLifecycle(match, 'HALF_TIME', minute);
      return;
    }

    if (minute === 46) {
      this.commitLifecycle(match, 'SECOND_HALF_KICK_OFF', minute);
    }

    if (minute === 90) {
      this.commitLifecycle(match, 'FULL_TIME', minute);
      this.finishMatch(match);
      return;
    }

    // In-play events scheduled for this minute.
    const bucket = match.planByMinute.get(minute);
    if (bucket) {
      for (const plan of bucket) {
        this.commitPlanned(match, plan);
      }
    }

    // Random burst chance (a spontaneous intense spell). Ambient bursts are SMALL
    // and realistic (a few cards/subs/offsides over a minute or two); the big
    // rate-stress burst is on-demand only, via POST /control/burst/:matchId.
    if (
      this.cfg.burstEnabled &&
      Math.random() < this.cfg.burstRandomProbability
    ) {
      const ambientSize = randInt(
        this.cfg.burstAmbientSizeMin,
        this.cfg.burstAmbientSizeMax,
      );
      this.triggerBurst(match.matchId, ambientSize);
    }
  }

  private finishMatch(match: MatchState): void {
    match.status = 'FINISHED';
    if (match.clock) clearInterval(match.clock);
    // Any in-flight burst timers are moot now.
    for (const t of match.burstTimers) clearTimeout(t);
    match.burstTimers.clear();

    const score = this.computeScore(match);
    this.logger.log(
      `FULL_TIME ${match.matchId}  ${match.homeTeam} ${score.home}-${score.away} ${match.awayTeam}`,
    );

    if (this.cfg.restartOnFullTime) {
      // Replace with a brand-new match (new matchId) so seq stays a clean
      // 1..N per match. The finished match's log is retained for REST catch-up.
      this.spawnMatch();
    }
  }

  // ── Commit (the ONLY place seq is assigned) ──────────────────────────────

  /**
   * Synchronously append an event to the canonical log and emit it. No `await`
   * between reading and incrementing seqCounter, so tick- and burst-driven
   * commits can never interleave to corrupt seq (correctness #4).
   */
  private commit(match: MatchState, partial: Omit<MatchEvent, 'seq' | 'eventId' | 'timestamp' | 'matchId'>): MatchEvent {
    const event: MatchEvent = {
      ...partial,
      matchId: match.matchId,
      seq: match.seqCounter,
      eventId: uuidv4(),
      timestamp: new Date().toISOString(),
    };
    match.seqCounter += 1;
    match.log.push(event);
    this.canonicalEvents.next(event);
    return event;
  }

  private commitLifecycle(
    match: MatchState,
    type: EventType,
    minute: number,
  ): void {
    // Match-status events carry no team/player.
    this.commit(match, { type, minute });
  }

  private commitPlanned(match: MatchState, plan: PlannedEvent): MatchEvent | null {
    let refEventId: string | undefined;
    let refSeq: number | undefined;

    if (plan.refPlan) {
      const target = plan.refPlan.committed;
      if (!target) {
        // Target never committed (shouldn't happen — reversal minute is strictly
        // later). Skip rather than emit a reversal that references nothing.
        this.logger.warn(
          `Skipping ${plan.type} in ${match.matchId}: referenced event not committed`,
        );
        return null;
      }
      refEventId = target.eventId;
      refSeq = target.seq;
    }

    const event = this.commit(match, {
      type: plan.type,
      team: plan.team,
      minute: plan.minute,
      player: plan.player,
      ...(refEventId ? { refEventId, refSeq } : {}),
      ...(plan.reason ? { reason: plan.reason } : {}),
    });
    plan.committed = event;
    return event;
  }

  // ── Bursts ───────────────────────────────────────────────────────────────

  /**
   * Rapidly commit BURST_SIZE genuine new in-play events for one match within
   * BURST_WINDOW_MS. Real seq, real log entries — a believable chaotic period.
   * Returns the number of events scheduled (0 if the match isn't live).
   */
  triggerBurst(matchId: string, sizeOverride?: number): number {
    const match = this.matches.get(matchId);
    if (!match || match.status !== 'LIVE') return 0;

    const size =
      sizeOverride ??
      randInt(this.cfg.burstSizeMin, this.cfg.burstSizeMax);

    this.logger.warn(`[CHAOS] burst of ${size} events (${matchId})`);

    for (let i = 0; i < size; i += 1) {
      const delay = Math.floor(Math.random() * this.cfg.burstWindowMs);
      const timer = setTimeout(() => {
        match.burstTimers.delete(timer);
        if (match.status !== 'LIVE') return;
        const type = pick(BURST_TYPES);
        const team: Team = randomTeam();
        // Spread the flurry across the current and previous sim-minute so it reads
        // as a 1–2 minute spell, not "N events all in the exact same minute".
        const minute = Math.max(1, match.simMinute - randInt(0, 1));
        this.commit(match, {
          type,
          team,
          minute,
          player: randomPlayer(),
        });
      }, delay);
      match.burstTimers.add(timer);
    }
    return size;
  }

  // ── Read API (REST) ──────────────────────────────────────────────────────

  private computeScore(match: MatchState): { home: number; away: number } {
    let home = 0;
    let away = 0;
    for (const e of match.log) {
      if (e.type === 'GOAL') e.team === 'home' ? (home += 1) : (away += 1);
      if (e.type === 'GOAL_CANCELLED') e.team === 'home' ? (home -= 1) : (away -= 1);
    }
    return { home: Math.max(0, home), away: Math.max(0, away) };
  }

  listMatches(includeFinished = false): MatchSummary[] {
    const out: MatchSummary[] = [];
    for (const match of this.matches.values()) {
      if (!includeFinished && match.status !== 'LIVE') continue;
      out.push({
        matchId: match.matchId,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        status: match.status,
        minute: match.simMinute,
        seqHighWater: match.seqCounter - 1,
        score: this.computeScore(match),
      });
    }
    return out;
  }

  hasMatch(matchId: string): boolean {
    return this.matches.has(matchId);
  }

  /** Clean canonical events for a match with seq > since, sorted by seq. */
  getEventsSince(matchId: string, since: number): MatchEvent[] {
    const match = this.matches.get(matchId);
    if (!match) return [];
    return match.log
      .filter((e) => e.seq > since)
      .sort((a, b) => a.seq - b.seq);
  }
}
